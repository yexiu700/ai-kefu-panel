'use strict'

function pollPolicy({ docked, visible, autoBind, pinned, now, lastForegroundPoll }) {
  const shouldSnap = docked && visible
  const foregroundIntervalMs = shouldSnap ? 280 : 1000
  return {
    shouldSnap,
    foregroundIntervalMs,
    shouldPollForeground: autoBind && !pinned && now - lastForegroundPoll >= foregroundIntervalMs,
    shouldRefreshRect: shouldSnap,
  }
}

module.exports = { pollPolicy }
