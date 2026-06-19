import Fastify from 'fastify';
import dotenv from 'dotenv';
import { pathToFileURL } from 'url';
import { postSignal, getSignals } from './signals.js';

dotenv.config();
const API_KEY = process.env.API_KEY || 'change-me';
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '127.0.0.1';

export function buildApp() {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL || 'info' } });

  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/healthz') return;
    const key = req.headers['x-api-key'];
    if (!key || key !== API_KEY) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  });

  app.get('/healthz', async () => ({ ok: true }));
  app.post('/v1/signals', postSignal);
  app.get('/v1/signals', getSignals);

  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = buildApp();
  app.listen({ host: HOST, port: PORT }).catch((e) => {
    app.log.error(e);
    process.exit(1);
  });
}
