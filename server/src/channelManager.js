/**
 * In-memory channel registry.
 *
 * channels: Map<channelName, Set<socket>>
 * presenceMembers: Map<channelName, Map<userId, { userInfo, socketIds: Set<string> }>>
 *
 * This is single-process only — fine for learning/small deployments.
 * To scale horizontally you'd back this with Redis pub/sub instead.
 */
class ChannelManager {
  constructor() {
    this.channels = new Map();
    this.presenceMembers = new Map();
  }

  isPresence(channel) {
    return channel.startsWith('presence-');
  }

  isPrivate(channel) {
    return channel.startsWith('private-');
  }

  subscribe(channel, socket) {
    if (!this.channels.has(channel)) this.channels.set(channel, new Set());
    this.channels.get(channel).add(socket);
  }

  unsubscribe(channel, socket) {
    const set = this.channels.get(channel);
    if (!set) return;
    set.delete(socket);
    if (set.size === 0) this.channels.delete(channel);
  }

  /** Removes a socket from every channel it was in (called on disconnect). */
  removeSocketEverywhere(socket) {
    const leftPresenceChannels = [];
    for (const [channel, set] of this.channels.entries()) {
      if (set.has(socket)) {
        set.delete(socket);
        if (set.size === 0) this.channels.delete(channel);
        if (this.isPresence(channel)) {
          const memberInfo = this.leavePresence(channel, socket);
          if (memberInfo) leftPresenceChannels.push({ channel, ...memberInfo });
        }
      }
    }
    return leftPresenceChannels;
  }

  socketsIn(channel) {
    return this.channels.get(channel) || new Set();
  }

  channelExists(channel) {
    return this.channels.has(channel) && this.channels.get(channel).size > 0;
  }

  /** Adds a member to a presence channel; returns whether this was their first connection (for member_added). */
  joinPresence(channel, socket, userId, userInfo) {
    if (!this.presenceMembers.has(channel)) this.presenceMembers.set(channel, new Map());
    const members = this.presenceMembers.get(channel);

    socket.presenceUserIds = socket.presenceUserIds || new Map();
    socket.presenceUserIds.set(channel, userId);

    if (members.has(userId)) {
      members.get(userId).socketIds.add(socket.id);
      return { isNew: false, userInfo: members.get(userId).userInfo };
    }

    members.set(userId, { userInfo, socketIds: new Set([socket.id]) });
    return { isNew: true, userInfo };
  }

  /** Removes a socket's membership; returns { userId, userInfo } if the user fully left (last socket). */
  leavePresence(channel, socket) {
    const members = this.presenceMembers.get(channel);
    if (!members) return null;

    const userId = socket.presenceUserIds && socket.presenceUserIds.get(channel);
    if (userId === undefined) return null;

    const member = members.get(userId);
    if (!member) return null;

    member.socketIds.delete(socket.id);
    if (member.socketIds.size === 0) {
      members.delete(userId);
      if (members.size === 0) this.presenceMembers.delete(channel);
      return { userId, userInfo: member.userInfo };
    }
    return null; // user still has other connections open
  }

  presenceMemberList(channel) {
    const members = this.presenceMembers.get(channel);
    if (!members) return { count: 0, hash: {} };
    const hash = {};
    for (const [userId, { userInfo }] of members.entries()) {
      hash[userId] = userInfo;
    }
    return { count: members.size, hash };
  }
}

module.exports = ChannelManager;
