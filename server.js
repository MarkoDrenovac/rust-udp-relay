const express = require('express');
const dgram = require('dgram');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS for all origins with specific headers
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-client-info', 'apikey'],
  credentials: false
}));
app.use(express.json());

// Add request logging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

class SourceQuery {
  constructor(timeout = 5000) {
    this.timeout = timeout;
  }

  // A2S_INFO query
  async getServerInfo(ip, port) {
    return new Promise((resolve, reject) => {
      const client = dgram.createSocket('udp4');
      const timeout = setTimeout(() => {
        client.close();
        reject(new Error('Timeout'));
      }, this.timeout);

      try {
        // A2S_INFO packet: 0xFF 0xFF 0xFF 0xFF 0x54 "Source Engine Query"
        const packet = Buffer.from([
          0xFF, 0xFF, 0xFF, 0xFF, 0x54,
          ...Buffer.from("Source Engine Query", 'ascii'),
          0x00
        ]);

        client.send(packet, port, ip, (err) => {
          if (err) {
            clearTimeout(timeout);
            client.close();
            reject(err);
            return;
          }
        });

        client.on('message', (data) => {
          clearTimeout(timeout);
          client.close();
          
          try {
            const parsed = this.parseServerInfo(data);
            resolve(parsed);
          } catch (parseErr) {
            reject(parseErr);
          }
        });

        client.on('error', (err) => {
          clearTimeout(timeout);
          client.close();
          reject(err);
        });

      } catch (err) {
        clearTimeout(timeout);
        client.close();
        reject(err);
      }
    });
  }

  // A2S_PLAYER query
  async getPlayers(ip, port) {
    return new Promise((resolve, reject) => {
      const client = dgram.createSocket('udp4');
      const timeout = setTimeout(() => {
        client.close();
        reject(new Error('Timeout'));
      }, this.timeout);

      try {
        // First, get challenge number with A2S_PLAYER challenge
        const challengePacket = Buffer.from([
          0xFF, 0xFF, 0xFF, 0xFF, 0x55,
          0xFF, 0xFF, 0xFF, 0xFF // challenge
        ]);

        client.send(challengePacket, port, ip, (err) => {
          if (err) {
            clearTimeout(timeout);
            client.close();
            reject(err);
            return;
          }
        });

        let challengeReceived = false;

        client.on('message', (data) => {
          if (!challengeReceived && data.length >= 9) {
            // This is challenge response
            challengeReceived = true;
            const challenge = data.slice(5, 9);
            
            // Send A2S_PLAYER with challenge
            const playerPacket = Buffer.from([
              0xFF, 0xFF, 0xFF, 0xFF, 0x55,
              ...challenge
            ]);

            client.send(playerPacket, port, ip, (err) => {
              if (err) {
                clearTimeout(timeout);
                client.close();
                reject(err);
              }
            });
          } else {
            // This is player data response
            clearTimeout(timeout);
            client.close();
            
            try {
              const parsed = this.parsePlayerInfo(data);
              resolve(parsed);
            } catch (parseErr) {
              reject(parseErr);
            }
          }
        });

        client.on('error', (err) => {
          clearTimeout(timeout);
          client.close();
          reject(err);
        });

      } catch (err) {
        clearTimeout(timeout);
        client.close();
        reject(err);
      }
    });
  }

  parseServerInfo(data) {
    if (data.length < 6 || data[4] !== 0x49) {
      throw new Error('Invalid server info response');
    }

    let offset = 6; // Skip header
    
    // Read null-terminated strings
    const readString = () => {
      const start = offset;
      while (offset < data.length && data[offset] !== 0) offset++;
      const str = data.slice(start, offset).toString('utf8');
      offset++; // Skip null terminator
      return str;
    };

    const readByte = () => data[offset++];
    const readShort = () => {
      const val = data.readUInt16LE(offset);
      offset += 2;
      return val;
    };

    try {
      const name = readString();
      const map = readString();
      const folder = readString();
      const game = readString();
      
      if (offset + 7 > data.length) {
        throw new Error('Insufficient data for server info');
      }

      const appId = readShort();
      const players = readByte();
      const maxPlayers = readByte();
      const bots = readByte();
      const serverType = readByte();
      const environment = readByte();

      return {
        name: name || 'Unknown Server',
        map: map || 'Unknown Map',
        game: game || 'Unknown Game',
        players: players || 0,
        maxPlayers: maxPlayers || 0,
        bots: bots || 0,
        appId: appId || 0
      };
    } catch (err) {
      console.error('Error parsing server info:', err);
      return {
        name: 'Parse Error',
        map: 'Unknown',
        game: 'Unknown',
        players: 0,
        maxPlayers: 0,
        bots: 0,
        appId: 0
      };
    }
  }

  parsePlayerInfo(data) {
    if (data.length < 6 || data[4] !== 0x44) {
      throw new Error('Invalid player info response');
    }

    const players = [];
    let offset = 6; // Skip header
    
    try {
      const playerCount = data[offset++];
      
      for (let i = 0; i < playerCount && offset < data.length; i++) {
        if (offset >= data.length) break;
        
        const index = data[offset++];
        
        // Read player name (null-terminated string)
        const nameStart = offset;
        while (offset < data.length && data[offset] !== 0) offset++;
        const name = data.slice(nameStart, offset).toString('utf8');
        offset++; // Skip null terminator
        
        if (offset + 8 > data.length) break;
        
        const score = data.readInt32LE(offset);
        offset += 4;
        
        const duration = data.readFloatLE(offset);
        offset += 4;
        
        if (name && name.length > 0) {
          players.push({
            index,
            name: name.trim(),
            score: score || 0,
            duration: duration || 0
          });
        }
      }
    } catch (err) {
      console.error('Error parsing player info:', err);
    }

    return players;
  }
}

// Health check endpoint
app.get('/health', (req, res) => {
  console.log('Health check requested');
  res.status(200).send('UDP Relay Service is running');
});

// Query single server
app.post('/query-server', async (req, res) => {
  const { ip, port } = req.body;
  
  console.log(`Querying server: ${ip}:${port}`);
  
  if (!ip || !port) {
    return res.status(400).json({ error: 'IP and port are required' });
  }

  const query = new SourceQuery(3000);
  const result = {
    ip,
    port,
    serverInfo: null,
    players: null,
    errors: {}
  };

  try {
    console.log(`Getting server info for ${ip}:${port}`);
    result.serverInfo = await query.getServerInfo(ip, port);
    console.log(`Server info success: ${result.serverInfo.players}/${result.serverInfo.maxPlayers} players`);
  } catch (err) {
    console.log(`Server info failed for ${ip}:${port}: ${err.message}`);
    result.errors.serverInfo = err.message;
  }

  try {
    console.log(`Getting players for ${ip}:${port}`);
    result.players = await query.getPlayers(ip, port);
    console.log(`Players success: ${result.players.length} players found`);
  } catch (err) {
    console.log(`Players failed for ${ip}:${port}: ${err.message}`);
    result.errors.players = err.message;
  }

  res.json(result);
});

// Query multiple servers
app.post('/query-batch', async (req, res) => {
  const { servers } = req.body;
  
  console.log(`Batch query for ${servers.length} servers`);
  
  if (!Array.isArray(servers)) {
    return res.status(400).json({ error: 'Servers array is required' });
  }

  const query = new SourceQuery(3000);
  const results = [];

  // Process servers in parallel but limit concurrency
  const BATCH_SIZE = 5;
  for (let i = 0; i < servers.length; i += BATCH_SIZE) {
    const batch = servers.slice(i, i + BATCH_SIZE);
    const batchPromises = batch.map(async (server) => {
      const result = {
        id: server.id,
        ip: server.ip,
        port: server.port,
        serverInfo: null,
        players: null,
        errors: {}
      };

      try {
        console.log(`Batch: Getting server info for ${server.ip}:${server.port}`);
        result.serverInfo = await query.getServerInfo(server.ip, server.port);
      } catch (err) {
        console.log(`Batch: Server info failed for ${server.ip}:${server.port}: ${err.message}`);
        result.errors.serverInfo = err.message;
      }

      try {
        console.log(`Batch: Getting players for ${server.ip}:${server.port}`);
        result.players = await query.getPlayers(server.ip, server.port);
      } catch (err) {
        console.log(`Batch: Players failed for ${server.ip}:${server.port}: ${err.message}`);
        result.errors.players = err.message;
      }

      return result;
    });

    const batchResults = await Promise.all(batchPromises);
    results.push(...batchResults);
    
    console.log(`Completed batch ${Math.floor(i/BATCH_SIZE) + 1}/${Math.ceil(servers.length/BATCH_SIZE)}`);
  }

  console.log(`Batch query complete: ${results.length} servers processed`);
  res.json({ results });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`UDP Relay Service running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  process.exit(0);
});
