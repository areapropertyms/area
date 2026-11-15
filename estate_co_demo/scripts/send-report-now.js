require('dotenv').config();
const { runDailyReport } = require('../services/dailyReports');
runDailyReport().then(() => {
  console.log('[daily-report] Manual report run completed.');
}).catch(error => {
  console.error('[daily-report] Manual report run completed with errors:', error.message);
  process.exitCode = 1;
});
