// manual override: close NEAR book, open NEAR long at high available-margin fill.
// Venue follows SENTINEL_EXCHANGE (same adapter as force-trade.mjs).
process.argv[2] = 'NEARUSDT';
process.argv[3] = 'LONG';
process.argv[4] = process.argv[4] || '0.9';
process.argv[5] = process.argv[5] || '4.0';
process.env.FORCE_FRACS ||= '0.97,0.94,0.90,0.85,0.80,0.70';
await import('./force-trade.mjs');
