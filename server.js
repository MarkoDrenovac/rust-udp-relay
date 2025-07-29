const dgram = require('dgram');
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Source Query Protocol implementation
class SourceQuery {
  static async queryServer(ip, port, timeout = 5000) {
    return new Promise((resolve) => {
      const client = dgram.createSocket('udp4');
      let resolved = false;
      
      // Set timeout
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          client.close();
          resolve({ success: false, error: 'Timeout' });
        }
      }, timeout);

      // A2S_INFO request packet
      const infoPacket = Buffer.from([
        0xFF, 0xFF, 0xFF, 0xFF, // Header
        0x54, // A2S_INFO
        ...Buffer.from('Source Engine Query\0', 'ascii')
      ]);

      client.on('error', (err) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          client.close();
          resolve({ success: false, error: err.message });
        }
      });

      client.on('message', (msg) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          client.close();
          
          try {
            const result = this.parseA2SInfo(msg);
            resolve({ success: true, data: result });
          } catch (error) {
            resolve({ success: false, error: error.message });
          }
        }
      });

      // Send query
      client.send(infoPacket, port, ip, (err) => {
        if (err && !resolved) {
          resolved = true;
          clearTimeout(timer);
          client.close();
          resolve({ success: false, error: err.message });
        }
      });
    });
  }

  static async queryPlayers(ip, port, timeout = 5000) {
    return new Promise((resolve) => {
      const client = dgram.createSocket('udp4');
      let resolved = false;
      let step = 'challenge';
      
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          client.close();
          resolve({ success: false, error: 'Timeout' });
        }
      }, timeout);

      // A2S_PLAYER challenge request
      const challengePacket = Buffer.from([
        0xFF, 0xFF, 0xFF, 0xFF, // Header
        0x55, // A2S_PLAYER
        0xFF, 0xFF, 0xFF, 0xFF  // Challenge
      ]);

      client.on('error', (err) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          client.close();
          resolve({ success: false, error: err.message });
        }
      });

      client.on('message', (msg) => {
        if (resolved) return;

        if (step === 'challenge') {
          // Parse challenge response
          if (msg.length >= 9 && msg[4] === 0x41) {
            const challenge = msg.slice(5, 9);
            
            // Send A2S_PLAYER with challenge
            const playerPacket = Buffer.from([
              0xFF, 0xFF, 0xFF, 0xFF, // Header
              0x55, // A2S_PLAYER
              ...challenge
            ]);
            
            step = 'players';
            client.send(playerPacket, port, ip);
          } else {
            resolved = true;
            clearTimeout(timer);
            client.close();
            resolve({ success: false, error: 'Invalid challenge response' });
          }
        } else if (step === 'players') {
          resolved = true;
          clearTimeout(timer);
          client.close();
          
          try {
            const result = this.parseA2SPlayers(msg);
            resolve({ success: true, data: result });
          } catch (error) {
            resolve({ success: false, error: error.message });
          }
        }
      });

      // Start with challenge request
      client.send(challengePacket, port, ip, (err) => {
        if (err && !resolved) {
          resolved = true;
          clearTimeout(timer);
          client.close();
          resolve({ success: false, error: err.message });
        }
      });
    });
  }

  static parseA2SInfo(buffer) {
    let offset = 5; // Skip header and type
    
    // Read strings and data according to A2S_INFO format
    const name = this.readString(buffer, offset);
    offset += name.length + 1;
    
    const map = this.readString(buffer, offset);
    offset += map.length + 1;
    
    const folder = this.readString(buffer, offset);
    offset += folder.length + 1;
    
    const game = this.readString(buffer, offset);
    offset += game.length + 1;
    
    if (offset + 8 <= buffer.length) {
      const players = buffer[offset + 2];
      const maxPlayers = buffer[offset + 3];
      
      return {
        name,
        map,
        folder,
        game,
        players,
        maxPlayers,
        protocol: buffer[offset + 1],
        serverType: String.fromCharCode(buffer[offset + 4]),
        environment: String.fromCharCode(buffer[offset + 5])
      };
    }
    
    return { name, map, folder, game, players: 0, maxPlayers: 0 };
  }

  static parseA2SPlayers(buffer) {
    if (buffer.length < 6) {
      return { players: [] };
    }

    const playerCount = buffer[5];
    const players = [];
    let offset = 6;

    for (let i = 0; i < playerCount && offset < buffer.length; i++) {
      if (offset >= buffer.length) break;
      
      const index = buffer[offset];
      offset++;
      
      const name = this.readString(buffer, offset);
      offset += name.length + 1;
      
      if (offset + 8 <= buffer.length) {
        const score = buffer.readInt32LE(offset);
        offset += 4;
        const duration = buffer.readFloatLE(offset);
        offset += 4;
        
        players.push({
          index,
          name,
          score,
          duration
        });
      }
    }

    return { players };
  }

  static readString(buffer, offset) {
    let end = offset;
    while (end < buffer.length && buffer[end] !== 0) {
      end++;
    }
    return buffer.slice(offset, end).toString('utf8');
  }
}

// API Endpoints
app.post('/query-server', async (req, res) => {
  const { ip, port } = req.body;
  
  if (!ip || !port) {
    return res.status(400).json({ error: 'IP and port required' });
  }

  console.log(`🔍 Querying server ${ip}:${port}`);
  
  try {
    const [serverInfo, playerInfo] = await Promise.all([
      SourceQuery.queryServer(ip, port),
      SourceQuery.queryPlayers(ip, port)
    ]);

    const result = {
      serverInfo: serverInfo.success ? serverInfo.data : null,
      players: playerInfo.success ? playerInfo.data.players : [],
      errors: {
        serverInfo: serverInfo.success ? null : serverInfo.error,
        players: playerInfo.success ? null : playerInfo.error
      }
    };

    console.log(`✅ ${ip}:${port} - Server: ${serverInfo.success ? 'OK' : 'FAIL'}, Players: ${playerInfo.success ? playerInfo.data.players.length : 'FAIL'}`);
    
    res.json(result);
  } catch (error) {
    console.error(`❌ Error querying ${ip}:${port}:`, error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/query-batch', async (req, res) => {
  const { servers } = req.body;
  
  if (!Array.isArray(servers)) {
    return res.status(400).json({ error: 'Servers array required' });
  }

  console.log(`🔍 Batch querying ${servers.length} servers`);
  
  const results = [];
  
  // Process in parallel but with concurrency limit
  const concurrency = 10;
  for (let i = 0; i < servers.length; i += concurrency) {
    const batch = servers.slice(i, i + concurrency);
    
    const batchPromises = batch.map(async (server) => {
      const [serverInfo, playerInfo] = await Promise.all([
        SourceQuery.queryServer(server.ip, server.port),
        SourceQuery.queryPlayers(server.ip, server.port)
      ]);

      return {
        id: server.id,
        ip: server.ip,
        port: server.port,
        serverInfo: serverInfo.success ? serverInfo.data : null,
        players: playerInfo.success ? playerInfo.data.players : [],
        errors: {
          serverInfo: serverInfo.success ? null : serverInfo.error,
          players: playerInfo.success ? null : playerInfo.error
        }
      };
    });

    const batchResults = await Promise.all(batchPromises);
    results.push(...batchResults);
    
    console.log(`✅ Processed batch ${Math.floor(i/concurrency) + 1}/${Math.ceil(servers.length/concurrency)}`);
    
    // Small delay between batches
    if (i + concurrency < servers.length) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  res.json({ results });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 UDP Relay Service running on port ${PORT}`);
  console.log(`📡 Ready to query Rust servers with real UDP connections`);
});

module.exports = app;
