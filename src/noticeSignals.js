// Tells a user's open pages that their notifications changed, so the nav badge
// updates at once. In memory, like live.js: it suits the single server this app
// runs on, and pages still catch up through their periodic check.
const { EventEmitter } = require('events');

const emitter = new EventEmitter();
// Every open page of every coach and admin listens.
emitter.setMaxListeners(0);

function signalUsers(userIds) {
  new Set(userIds).forEach((id) => emitter.emit(`user:${id}`));
}

// Calls `listener` on each change for the user. Returns a function that stops it.
function onUserNotice(userId, listener) {
  emitter.on(`user:${userId}`, listener);
  return () => emitter.off(`user:${userId}`, listener);
}

module.exports = { signalUsers, onUserNotice };
