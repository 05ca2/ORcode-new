// ORcode - 数据库持久化模块 (纯 JS)
// 使用 Node.js 内置 SQLite 实现数据持久化

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DB_NAME = 'orcode.db';
const DB_PATH = path.join(process.env.HOME || process.env.USERPROFILE || __dirname, '.orcode');

// 数据库管理器类
class DatabaseManager {
  constructor() {
    this.db = null;
    this.isInitialized = false;
    this.inMemoryData = {
      sessions: [],
      messages: [],
      metadata: []
    };
  }

  // 初始化数据库
  initialize(silent) {
    if (this.isInitialized) return;

    try {
      // 尝试使用 Node 22+ 内置 SQLite
      const { DatabaseSync } = require('node:sqlite');

      if (!fs.existsSync(DB_PATH)) {
        fs.mkdirSync(DB_PATH, { recursive: true });
      }

      this.db = new DatabaseSync(path.join(DB_PATH, DB_NAME));
      this.createTables();
      if (!silent) console.log('✅ 数据库初始化完成 (SQLite)');
    } catch (e) {
      // 降级到内存存储
      if (!silent) console.log('⚠️  SQLite 不可用，使用内存存储');
      this.db = null;
    }

    this.isInitialized = true;
  }

  createTables() {
    if (!this.db) return;

    this.db.prepare(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        instruction TEXT NOT NULL,
        status TEXT NOT NULL,
        models_used TEXT NOT NULL,
        start_time DATETIME NOT NULL,
        end_time DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `).run();

    this.db.prepare(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        position TEXT NOT NULL,
        message TEXT NOT NULL,
        type TEXT NOT NULL,
        timestamp DATETIME NOT NULL
      )
    `).run();

    this.db.prepare(`
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `).run();
  }

  // 创建会话
  createSession(sessionId, instruction, models) {
    this.initialize();

    const now = new Date().toISOString();

    if (this.db) {
      this.db.prepare(`
        INSERT INTO sessions (id, instruction, status, models_used, start_time)
        VALUES (?, ?, ?, ?, ?)
      `).run(sessionId, instruction, 'active', JSON.stringify(models), now);
    } else {
      this.inMemoryData.sessions.push({
        id: sessionId,
        instruction,
        status: 'active',
        models_used: JSON.stringify(models),
        start_time: now
      });
    }

    this.logMessage(sessionId, 'director', `开始新会话: "${instruction.substring(0, 50)}..."`, 'info');
    return sessionId;
  }

  // 加载会话
  loadSession(sessionId) {
    this.initialize();

    let result = null;
    if (this.db) {
      result = this.db.prepare(`
        SELECT * FROM sessions WHERE id = ?
      `).get(sessionId);
    } else {
      result = this.inMemoryData.sessions.find(s => s.id === sessionId);
    }

    if (!result) return null;

    return {
      sessionId: result.id,
      instruction: result.instruction,
      modelsUsed: JSON.parse(result.models_used),
      startTime: new Date(result.start_time),
      endTime: result.end_time ? new Date(result.end_time) : undefined,
      status: result.status,
      metrics: { workersRan: 0, verifierRounds: 0, totalDuration: 0 }
    };
  }

  // 更新会话状态
  updateSessionStatus(sessionId, status) {
    this.initialize();
    const now = new Date().toISOString();

    if (this.db) {
      if (status === 'completed') {
        this.db.prepare(`
          UPDATE sessions SET status = ?, end_time = ?, updated_at = ?
          WHERE id = ?
        `).run(status, now, now, sessionId);
      } else {
        this.db.prepare(`
          UPDATE sessions SET status = ?, updated_at = ?
          WHERE id = ?
        `).run(status, now, sessionId);
      }
    } else {
      const session = this.inMemoryData.sessions.find(s => s.id === sessionId);
      if (session) {
        session.status = status;
        session.updated_at = now;
        if (status === 'completed') session.end_time = now;
      }
    }
  }

  // 日志消息
  logMessage(sessionId, position, message, type) {
    this.initialize();
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    if (this.db) {
      this.db.prepare(`
        INSERT INTO messages (id, session_id, position, message, type, timestamp)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(id, sessionId, position, message, type, now);
    } else {
      this.inMemoryData.messages.push({
        id, session_id: sessionId, position, message, type, timestamp: now
      });
    }
  }

  // 获取会话日志
  getSessionLogs(sessionId, limit) {
    this.initialize();
    limit = limit || 100;

    let results;
    if (this.db) {
      results = this.db.prepare(`
        SELECT * FROM messages WHERE session_id = ?
        ORDER BY timestamp DESC LIMIT ?
      `).all(sessionId, limit);
    } else {
      results = this.inMemoryData.messages
        .filter(m => m.session_id === sessionId)
        .slice(-limit)
        .reverse();
    }

    return results.map(r => ({
      sessionId: r.session_id,
      position: r.position,
      message: r.message,
      timestamp: new Date(r.timestamp),
      type: r.type
    }));
  }

  // 获取所有会话
  getAllSessions(limit) {
    this.initialize();
    limit = limit || 20;

    let results;
    if (this.db) {
      results = this.db.prepare(`
        SELECT * FROM sessions ORDER BY start_time DESC LIMIT ?
      `).all(limit);
    } else {
      results = this.inMemoryData.sessions.slice(-limit).reverse();
    }

    return results.map(r => ({
      sessionId: r.id,
      instruction: r.instruction,
      modelsUsed: JSON.parse(r.models_used),
      startTime: new Date(r.start_time),
      endTime: r.end_time ? new Date(r.end_time) : undefined,
      status: r.status,
      metrics: { workersRan: 0, verifierRounds: 0, totalDuration: 0 }
    }));
  }

  // 删除会话
  deleteSession(sessionId) {
    this.initialize();

    if (this.db) {
      this.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sessionId);
    } else {
      const idx = this.inMemoryData.sessions.findIndex(s => s.id === sessionId);
      if (idx >= 0) this.inMemoryData.sessions.splice(idx, 1);
    }
  }

  // 获取统计数据
  getStatistics() {
    this.initialize();

    let total, completed, active;
    if (this.db) {
      total = this.db.prepare(`SELECT COUNT(*) as count FROM sessions`).get().count;
      completed = this.db.prepare(`SELECT COUNT(*) as count FROM sessions WHERE status = ?`).get('completed').count;
      active = this.db.prepare(`SELECT COUNT(*) as count FROM sessions WHERE status = ?`).get('active').count;
    } else {
      const sessions = this.inMemoryData.sessions;
      total = sessions.length;
      completed = sessions.filter(s => s.status === 'completed').length;
      active = sessions.filter(s => s.status === 'active').length;
    }

    const modelUsage = {};
    const sessions = this.getAllSessions(100);
    for (const session of sessions) {
      for (const model in session.modelsUsed) {
        if (!modelUsage[model]) modelUsage[model] = 0;
        modelUsage[model]++;
      }
    }

    return { totalSessions: total, completedSessions: completed, activeSessions: active, avgDuration: 0, modelUsage };
  }

  // 中间状态存储
  storeIntermediateState(sessionId, key, value) {
    this.initialize();
    const metaKey = `session_${sessionId}_${key}`;
    const now = new Date().toISOString();

    if (this.db) {
      this.db.prepare(`
        INSERT OR REPLACE INTO metadata (key, value, updated_at)
        VALUES (?, ?, ?)
      `).run(metaKey, JSON.stringify(value), now);
    } else {
      const idx = this.inMemoryData.metadata.findIndex(m => m.key === metaKey);
      if (idx >= 0) {
        this.inMemoryData.metadata[idx].value = JSON.stringify(value);
        this.inMemoryData.metadata[idx].updated_at = now;
      } else {
        this.inMemoryData.metadata.push({ key: metaKey, value: JSON.stringify(value), updated_at: now });
      }
    }
  }

  getIntermediateState(sessionId, key) {
    this.initialize();
    const metaKey = `session_${sessionId}_${key}`;

    let result = null;
    if (this.db) {
      result = this.db.prepare(`SELECT value FROM metadata WHERE key = ?`).get(metaKey);
    } else {
      result = this.inMemoryData.metadata.find(m => m.key === metaKey);
    }

    return result ? JSON.parse(result.value) : null;
  }

  // 关闭数据库
  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.isInitialized = false;
    }
  }
}

// 导出单例
const dbManager = new DatabaseManager();

module.exports = { DatabaseManager, dbManager };
