const path = require('path');
const express = require('express');
const http = require('http');
const net = require('net');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const next = require('next');

require('dotenv').config({ path: path.join(__dirname, '../server/.env') });

const authRoutes = require('../server/src/routes/auth.routes');
const worldRoutes = require('../server/src/routes/world.routes');
const companyRoutes = require('../server/src/routes/company.routes');
const tradingRoutes = require('../server/src/routes/trading.routes');
const portfolioRoutes = require('../server/src/routes/portfolio.routes');
const marketRoutes = require('../server/src/routes/market.routes');
const chatRoutes = require('../server/src/routes/chat.routes');
const settingsRoutes = require('../server/src/routes/settings.routes');

const db = require('../server/src/config/database');
const wsHandler = require('../server/src/websocket/ws.handler');
const simulationService = require('../server/src/services/simulation.service');

const dev = process.env.NODE_ENV !== 'production';
const requestedPort = Number(process.env.PORT || 5000);
const hostname = process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : 'localhost');

const probeRoute = (probePort, probePath, onResponse) => {
  const probeHost = (hostname === '0.0.0.0' || hostname === '::') ? '127.0.0.1' : hostname;

  return new Promise((resolve) => {
    const request = http.request(
      {
        method: 'GET',
        hostname: probeHost,
        port: probePort,
        path: probePath,
        timeout: 1200
      },
      (response) => {
        let body = '';

        response.on('data', (chunk) => {
          body += String(chunk);
        });

        response.on('end', () => {
          resolve(onResponse(response, body));
        });
      }
    );

    request.on('timeout', () => {
      request.destroy();
      resolve(false);
    });

    request.on('error', () => {
      resolve(false);
    });

    request.end();
  });
};

const isExistingMarketWorldServerRunning = async (probePort = requestedPort) => {
  const healthOk = await probeRoute(probePort, '/api/health', (response, body) => {
    if (response.statusCode !== 200) {
      return false;
    }

    try {
      const payload = JSON.parse(body);
      return payload?.status === 'ok';
    } catch {
      return false;
    }
  });

  if (!healthOk) {
    return false;
  }

  const rootLooksLikeNextApp = await probeRoute(probePort, '/', (response, body) => {
    const status = Number(response.statusCode || 0);
    const contentType = String(response.headers?.['content-type'] || '').toLowerCase();
    const poweredBy = String(response.headers?.['x-powered-by'] || '').toLowerCase();
    const htmlBody = String(body || '');

    if (status < 200 || status >= 400) {
      return false;
    }

    if (!contentType.includes('text/html')) {
      return false;
    }

    const hasMarketWorldTitle = htmlBody.toLowerCase().includes('<title>market world');
    const hasNextMarkers = htmlBody.includes('/_next/static/') || htmlBody.includes('id="__next"');
    const hasNextHeader = poweredBy.includes('next');

    return hasMarketWorldTitle && (hasNextMarkers || hasNextHeader);
  });

  if (!rootLooksLikeNextApp) {
    return false;
  }

  return probeRoute(probePort, '/dashboard', (response) => {
    const status = Number(response.statusCode || 0);

    if (status === 404) {
      return false;
    }

    return status >= 200 && status < 400;
  });
};

const isPortAvailable = (probePort) => {
  return new Promise((resolve) => {
    const tester = net.createServer();

    tester.once('error', (error) => {
      if (error?.code === 'EADDRINUSE') {
        resolve(false);
        return;
      }

      resolve(false);
    });

    tester.once('listening', () => {
      tester.close(() => resolve(true));
    });

    tester.listen(probePort);
  });
};

const resolveStartupPort = async () => {
  if (await isExistingMarketWorldServerRunning(requestedPort)) {
    return { mode: 'already-running', port: requestedPort };
  }

  if (await isPortAvailable(requestedPort)) {
    return { mode: 'fresh', port: requestedPort };
  }

  for (let offset = 1; offset <= 20; offset += 1) {
    const candidate = requestedPort + offset;
    if (await isPortAvailable(candidate)) {
      return { mode: 'fallback', port: candidate };
    }
  }

  throw new Error(`No available port found near ${requestedPort}.`);
};

const listenWithSingleInstanceGuard = (server, listenPort) => {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      server.off('listening', onListening);
      server.off('error', onError);
    };

    const onListening = () => {
      cleanup();
      resolve('listening');
    };

    const onError = (error) => {
      cleanup();

      if (error?.code !== 'EADDRINUSE') {
        reject(error);
        return;
      }

      isExistingMarketWorldServerRunning(listenPort)
        .then((isRunning) => {
          if (isRunning) {
            console.log(`Market World server is already running at http://${hostname}:${listenPort}. Reusing existing process.`);
            resolve('already-running');
            return;
          }

          reject(new Error(`Port ${listenPort} is already in use by another process.`));
        })
        .catch((probeError) => {
          reject(probeError);
        });
    };

    server.once('listening', onListening);
    server.once('error', onError);
    server.listen(listenPort);
  });
};

const bootstrapRealtimeSystems = async (wss) => {
  wsHandler.initWebSocket(wss);

  try {
    await simulationService.startSimulation();
  } catch (error) {
    console.error('Failed to start simulation service:', error);
  }
};

const bootServer = async () => {
  const startup = await resolveStartupPort();

  if (startup.mode === 'already-running') {
    console.log(`Market World server is already running at http://${hostname}:${startup.port}. Reusing existing process.`);
    process.exit(0);
    return;
  }

  const listenPort = Number(startup.port);
  if (startup.mode === 'fallback') {
    console.log(`Port ${requestedPort} is occupied by another process. Starting Market World on http://${hostname}:${listenPort} instead.`);
  }

  await db.initialize();

  const nextApp = next({
    dev,
    dir: __dirname,
    hostname,
    port: listenPort
  });
  const handle = nextApp.getRequestHandler();

  await nextApp.prepare();

    const app = express();
    const server = http.createServer(app);
    const wss = new WebSocketServer({ noServer: true });
    const nextUpgradeHandler = nextApp.getUpgradeHandler();

    server.on('upgrade', (req, socket, head) => {
      const requestPath = (req.url || '').split('?')[0];

      if (requestPath === '/ws') {
        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit('connection', ws, req);
        });
        return;
      }

      nextUpgradeHandler(req, socket, head);
    });

    app.use(
      cors({
        origin: true,
        credentials: true
      })
    );
    app.use(express.json());

    app.use((req, res, nextMiddleware) => {
      console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
      nextMiddleware();
    });

    app.use('/api/auth', authRoutes);
    app.use('/api/worlds', worldRoutes);
    app.use('/api/companies', companyRoutes);
    app.use('/api/trading', tradingRoutes);
    app.use('/api/portfolio', portfolioRoutes);
    app.use('/api/market', marketRoutes);
    app.use('/api/chat', chatRoutes);
    app.use('/api/settings', settingsRoutes);

    app.get('/api/health', async (req, res) => {
      try {
        const dbInstance = await db.getDb();
        await dbInstance.command({ ping: 1 });
        res.json({ status: 'ok', database: 'connected' });
      } catch (error) {
        res.status(500).json({ status: 'error', message: 'Database connection failed' });
      }
    });

    app.use('/api', (req, res) => {
      res.status(404).json({ error: 'Endpoint not found' });
    });

    app.use((req, res) => handle(req, res));

    app.use((err, req, res, nextMiddleware) => {
      console.error('Unhandled server error:', err);
      res.status(500).json({ error: 'Internal Server Error' });
    });

    const listenStatus = await listenWithSingleInstanceGuard(server, listenPort);
    if (listenStatus === 'already-running') {
      process.exit(0);
      return;
    }

    console.log(`Market World Next server running at http://${hostname}:${listenPort}`);
    await bootstrapRealtimeSystems(wss);
};

bootServer()
  .catch((error) => {
    console.error('Failed to boot Next server:', error);
    process.exit(1);
  });

