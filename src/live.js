// Tells open court screens that a competition changed, so they can update at
// once. In memory, which suits the single server this app runs on. Screens
// that miss a signal still catch up through their periodic check.
const { EventEmitter } = require('events');

function createLiveUpdates() {
  const emitter = new EventEmitter();
  // Every open screen listens, so there may be many.
  emitter.setMaxListeners(0);
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

module.exports = { createLiveUpdates };
