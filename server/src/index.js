import { createApp } from './app.js';
import { config } from './config/env.js';

const app = createApp();

app.listen(config.port, () => {
  console.log(
    JSON.stringify({
      level: 'info',
      message: 'API listening',
      port: config.port,
      env: config.nodeEnv,
      database: config.mongodbUri ? 'configured' : 'unconfigured',
    }),
  );
});
