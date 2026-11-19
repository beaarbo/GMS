// Live updates for open pages: signals that something changed, and the
// server-sent event stream that carries them to the browser. In memory, which
// suits the single server this app runs on; several would need a shared channel.
const { EventEmitter } = require('events');

const HEARTBEAT_MS = 25000;
const COALESCE_MS = 300;

const newEmitter = () => {
  const emitter = new EventEmitter();
  // Every open page listens, so there may be many.
  emitter.setMaxListeners(0);
  return emitter;
};

// A competition changed: open court screens update. One per app.
function createLiveUpdates() {
  const emitter = newEmitter();
  return {
    notify(competitionId) {
      if (competitionId) emitter.emit(`competition:${competitionId}`);
    },
    // Calls `listener` on each change to the competition. Returns a function that stops it.
    subscribe(competitionId, listener) {
      const event = `competition:${competitionId}`;
      emitter.on(event, listener);
      return () => emitter.off(event, listener);
    },
    listenerCount(competitionId) {
      return emitter.listenerCount(`competition:${competitionId}`);
    },
  };
}

// A user's notifications changed: their nav badge updates. Kept per database,
// since notices are added where only the database is at hand.
const userEmitters = new WeakMap();
const usersOf = (db) => {
  if (!userEmitters.has(db)) userEmitters.set(db, newEmitter());
  return userEmitters.get(db);
};

function signalUsers(db, userIds) {
  new Set(userIds).forEach((id) => usersOf(db).emit(`user:${id}`));
}

// Calls `listener` on each change for the user. Returns a function that stops it.
function onUserNotice(db, userId, listener) {
  usersOf(db).on(`user:${userId}`, listener);
  return () => usersOf(db).off(`user:${userId}`, listener);
}

// Opens a server-sent event stream: `subscribe(onChange)` starts listening and
// returns a stop function, and `send()` writes an event. A burst of changes
// becomes one send. Comments keep the connection open through proxies, and the
// browser reconnects on its own (after 5 s), then catches up from what it's sent.
function eventStream(req, res, subscribe, send) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 5000\n\n');
  let pending = null;
  const unsubscribe = subscribe(() => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      send();
    }, COALESCE_MS);
  });
  const heartbeat = setInterval(() => res.write(': still here\n\n'), HEARTBEAT_MS);
  req.on('close', () => {
    clearInterval(heartbeat);
    clearTimeout(pending);
    unsubscribe();
  });
}

module.exports = { createLiveUpdates, signalUsers, onUserNotice, eventStream };
