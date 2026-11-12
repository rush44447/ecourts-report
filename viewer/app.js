const { startEcourtsApi } = require('./services/ecourtsApi');
const { log } = require('./utils/logger');

log('Ecourts viewer starting...');
startEcourtsApi();
