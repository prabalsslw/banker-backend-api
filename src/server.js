require('dotenv').config();

const connectDB = require('./config/db');
const app = require('./app');
const { processDueCumulativeFdrs } = require('./utils/fdrMaturity');

const PORT = Number(process.env.PORT) || 3000;

async function start() {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    throw new Error('JWT_SECRET must be configured and contain at least 32 characters.');
  }

  await connectDB();

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`bAnker API listening on port ${PORT}`);
  });

  // Process due cumulative FDRs at startup and hourly. The FDR list endpoint
  // also reconciles on access, so due maturity is handled even after restarts.
  const runMaturitySweep = () => processDueCumulativeFdrs().catch((error) => {
    console.error('Cumulative FDR maturity sweep failed:', error.message);
  });
  runMaturitySweep();
  const maturityTimer = setInterval(runMaturitySweep, 60 * 60 * 1000);
  if (typeof maturityTimer.unref === 'function') maturityTimer.unref();
}

start().catch((error) => {
  console.error('Failed to start bAnker API:', error.message);
  process.exit(1);
});
