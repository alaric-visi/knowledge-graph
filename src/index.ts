import { loadConfig } from './config';
import { startServer, startupLog } from './server';

const cfg = loadConfig();

startServer(cfg).then(
  () => startupLog(cfg).forEach(line => console.log(line)),
  err => {
    console.error(`knowledge-graph failed to start: ${err}`);
    process.exit(1);
  },
);
