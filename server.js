import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { z } from 'zod';
import { DatabaseSync } from 'node:sqlite';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes, createHash } from 'crypto';

// ── Database ─────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || join(__dirname, 'trainer.db');
const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS profile (
    id INTEGER PRIMARY KEY DEFAULT 1,
    name TEXT,
    fitness_goal TEXT,
    fitness_level TEXT DEFAULT 'intermediate',
    equipment TEXT,
    injuries TEXT,
    training_days_per_week INTEGER,
    session_duration_minutes INTEGER,
    preferred_style TEXT,
    training_history TEXT,
    notes TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS workout_plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    day_of_week TEXT,
    exercises TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    active INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS workout_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    exercise TEXT NOT NULL,
    sets_completed INTEGER,
    reps_per_set TEXT,
    weight_lbs REAL,
    duration_minutes REAL,
    rpe INTEGER,
    notes TEXT,
    logged_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS food_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    meal TEXT NOT NULL,
    calories INTEGER,
    protein_g REAL,
    carbs_g REAL,
    fat_g REAL,
    notes TEXT,
    logged_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS oauth_codes (
    code TEXT PRIMARY KEY,
    code_challenge TEXT,
    code_challenge_method TEXT,
    redirect_uri TEXT,
    created_at INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS oauth_tokens (
    token TEXT PRIMARY KEY,
    created_at INTEGER DEFAULT (unixepoch())
  );
`);

// ── OAuth helpers ─────────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  const token = auth.slice(7);
  const stored = db.prepare('SELECT token FROM oauth_tokens WHERE token = ?').get(token);
  if (!stored) {
    res.status(401).json({ error: 'invalid_token' });
    return;
  }
  next();
}

// ── Tool registration ────────────────────────────────────────────────────────

function registerTools(server) {

  server.tool('start_session', 'Call this at the start of every conversation. Returns onboarding questions if profile is incomplete, or full training context if ready.', {}, async () => {
    const profile = db.prepare('SELECT * FROM profile WHERE id = 1').get();

    if (!profile || !profile.fitness_goal) {
      return { content: [{ type: 'text', text: JSON.stringify({
        status: 'needs_onboarding',
        instructions: 'New client. Introduce yourself as Coach with energy and excitement. Then say exactly this: "Share whatever you want me to know — where you are today, where you want to be, by when, what your goals are, what equipment you have available. The more context the better." Then wait. When they respond, extract everything useful and call update_profile once to save it all. Then build their program and save it with save_workout_plan.',
      }, null, 2) }] };
    }

    const recentWorkouts = db.prepare(`SELECT * FROM workout_logs WHERE logged_at >= datetime('now', '-7 days') ORDER BY logged_at DESC LIMIT 30`).all();
    const todayExercises = db.prepare(`SELECT * FROM workout_logs WHERE date(logged_at) = date('now') ORDER BY logged_at`).all();
    const todayFood = db.prepare(`SELECT * FROM food_logs WHERE date(logged_at) = date('now') ORDER BY logged_at`).all();
    const plans = db.prepare(`SELECT * FROM workout_plans WHERE active = 1 ORDER BY day_of_week`).all();

    return { content: [{ type: 'text', text: JSON.stringify({
      status: 'ready',
      instructions: {
        role: 'You are Coach — an energetic, fun, and genuinely excited personal trainer who loves helping people get after it. You bring real enthusiasm to every session without being fake or over the top.',
        session_start: 'Greet the user by name with energy. Reference what they did recently if anything — call them out for crushing it or missing days. Ask what they want to work on today.',
        programming: 'Design workouts based on the profile. Apply progressive overload — always check recent_workouts before prescribing weights or reps. Match exercises to available equipment. Get excited about their progress.',
        during_workout: 'Walk through one exercise at a time. Keep it punchy and motivating — short cues, real encouragement, no lectures. Celebrate wins out loud.',
        logging: 'Call log_exercise the moment the user says they finished anything — do not wait or ask permission. Log food when they mention eating.',
        tone: 'Fun, friendly, and fired up — but always honest. If they are slacking, skipping sessions, or eating like garbage, call it out directly with humor and zero judgment. Candid is caring. Never sugarcoat progress or lack of it.',
        plans: 'If no workout plans exist, build one based on the profile, get excited about it, and save it with save_workout_plan before starting the session.',
      },
      profile,
      workout_plans: plans.map(p => ({ ...p, exercises: JSON.parse(p.exercises) })),
      recent_workouts_7_days: recentWorkouts,
      todays_exercises_so_far: todayExercises,
      todays_food_so_far: todayFood,
    }, null, 2) }] };
  });

  server.tool('get_profile', 'Get the user\'s fitness profile, goals, equipment, and injuries', {}, async () => {
    const profile = db.prepare('SELECT * FROM profile WHERE id = 1').get();
    if (!profile) return { content: [{ type: 'text', text: 'No profile set yet. Use update_profile to create one.' }] };
    return { content: [{ type: 'text', text: JSON.stringify(profile, null, 2) }] };
  });

  server.tool('update_profile', 'Update fitness profile — call this when user shares any info about themselves', {
    name: z.string().optional(),
    fitness_goal: z.string().optional().describe('e.g. "lose fat, build muscle, improve endurance"'),
    fitness_level: z.enum(['beginner', 'intermediate', 'advanced']).optional(),
    equipment: z.string().optional().describe('List of available equipment, e.g. "squat rack, dumbbells, pull-up bar, bench"'),
    injuries: z.string().optional().describe('Any injuries, limitations, or exercises to avoid'),
    training_days_per_week: z.number().optional().describe('How many days per week they can train'),
    session_duration_minutes: z.number().optional().describe('How long each session can be in minutes'),
    preferred_style: z.string().optional().describe('e.g. "strength, hypertrophy, HIIT, powerlifting, general fitness"'),
    training_history: z.string().optional().describe('e.g. "3 years lifting, mostly machines, new to free weights"'),
    notes: z.string().optional(),
  }, async (params) => {
    const existing = db.prepare('SELECT * FROM profile WHERE id = 1').get();
    if (!existing) {
      db.prepare(`INSERT INTO profile (id, name, fitness_goal, fitness_level, equipment, injuries, training_days_per_week, session_duration_minutes, preferred_style, training_history, notes, updated_at)
        VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`)
        .run(params.name ?? null, params.fitness_goal ?? null, params.fitness_level ?? 'intermediate',
          params.equipment ?? null, params.injuries ?? null,
          params.training_days_per_week ?? null, params.session_duration_minutes ?? null,
          params.preferred_style ?? null, params.training_history ?? null, params.notes ?? null);
    } else {
      const fields = [];
      const values = [];
      for (const [key, val] of Object.entries(params)) {
        if (val !== undefined) { fields.push(`${key} = ?`); values.push(val); }
      }
      fields.push("updated_at = datetime('now')");
      if (fields.length > 1) db.prepare(`UPDATE profile SET ${fields.join(', ')} WHERE id = 1`).run(...values);
    }
    const updated = db.prepare('SELECT * FROM profile WHERE id = 1').get();
    return { content: [{ type: 'text', text: `Profile updated:\n${JSON.stringify(updated, null, 2)}` }] };
  });

  server.tool('get_workout_plans', 'Get all saved workout plans', {}, async () => {
    const plans = db.prepare('SELECT * FROM workout_plans WHERE active = 1 ORDER BY day_of_week').all();
    if (!plans.length) return { content: [{ type: 'text', text: 'No workout plans saved yet.' }] };
    return { content: [{ type: 'text', text: JSON.stringify(plans.map(p => ({ ...p, exercises: JSON.parse(p.exercises) })), null, 2) }] };
  });

  server.tool('save_workout_plan', 'Save a workout plan — call this after designing a program with the user', {
    name: z.string().describe('e.g. "Push Day", "Monday Legs", "Full Body A"'),
    day_of_week: z.string().optional().describe('e.g. "Monday" or "Any"'),
    exercises: z.array(z.object({
      name: z.string(),
      sets: z.number(),
      reps: z.string().describe('e.g. "10", "8-12", "AMRAP"'),
      weight_note: z.string().optional().describe('e.g. "bodyweight", "135 lbs", "RPE 7"'),
      rest_seconds: z.number().optional(),
      notes: z.string().optional(),
    })),
  }, async (params) => {
    db.prepare(`INSERT INTO workout_plans (name, day_of_week, exercises) VALUES (?, ?, ?)`)
      .run(params.name, params.day_of_week ?? null, JSON.stringify(params.exercises));
    return { content: [{ type: 'text', text: `Workout plan "${params.name}" saved.` }] };
  });

  server.tool('log_exercise', 'Log a completed exercise — call this immediately when user says they finished a set or exercise', {
    exercise: z.string().describe('Exercise name, e.g. "Back Squat", "Pull-up"'),
    sets_completed: z.number().optional(),
    reps_per_set: z.string().optional().describe('e.g. "10,10,8" or "10" if all sets equal'),
    weight_lbs: z.number().optional(),
    duration_minutes: z.number().optional(),
    rpe: z.number().min(1).max(10).optional().describe('Rate of perceived exertion 1-10'),
    notes: z.string().optional(),
  }, async (params) => {
    const result = db.prepare(`INSERT INTO workout_logs (exercise, sets_completed, reps_per_set, weight_lbs, duration_minutes, rpe, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(params.exercise, params.sets_completed ?? null, params.reps_per_set ?? null,
        params.weight_lbs ?? null, params.duration_minutes ?? null,
        params.rpe ?? null, params.notes ?? null);
    return { content: [{ type: 'text', text: `Logged: ${params.exercise} at ${new Date().toLocaleString()} (id: ${result.lastInsertRowid})` }] };
  });

  server.tool('get_todays_workout_summary', 'Get everything logged today — exercises and food', {}, async () => {
    const exercises = db.prepare(`SELECT * FROM workout_logs WHERE date(logged_at) = date('now') ORDER BY logged_at`).all();
    const food = db.prepare(`SELECT * FROM food_logs WHERE date(logged_at) = date('now') ORDER BY logged_at`).all();
    return { content: [{ type: 'text', text: JSON.stringify({
      date: new Date().toLocaleDateString(),
      exercises_logged: exercises.length,
      exercises,
      food_logged: food.length,
      total_calories_today: food.reduce((s, f) => s + (f.calories || 0), 0),
      total_protein_today_g: food.reduce((s, f) => s + (f.protein_g || 0), 0),
      food,
    }, null, 2) }] };
  });

  server.tool('get_recent_workouts', 'Get recent workout history to inform programming', {
    days: z.number().default(14).describe('Days of history to retrieve'),
    exercise: z.string().optional().describe('Filter by exercise name'),
  }, async (params) => {
    let query = `SELECT * FROM workout_logs WHERE logged_at >= datetime('now', '-${params.days} days')`;
    const args = [];
    if (params.exercise) { query += ' AND exercise LIKE ?'; args.push(`%${params.exercise}%`); }
    query += ' ORDER BY logged_at DESC LIMIT 100';
    const logs = db.prepare(query).all(...args);
    if (!logs.length) return { content: [{ type: 'text', text: `No workouts in the last ${params.days} days.` }] };
    return { content: [{ type: 'text', text: JSON.stringify(logs, null, 2) }] };
  });

  server.tool('log_food', 'Log a meal — call this when user mentions what they ate', {
    meal: z.string().describe('e.g. "chicken breast with rice and broccoli"'),
    calories: z.number().optional(),
    protein_g: z.number().optional(),
    carbs_g: z.number().optional(),
    fat_g: z.number().optional(),
    notes: z.string().optional(),
  }, async (params) => {
    const result = db.prepare(`INSERT INTO food_logs (meal, calories, protein_g, carbs_g, fat_g, notes) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(params.meal, params.calories ?? null, params.protein_g ?? null, params.carbs_g ?? null, params.fat_g ?? null, params.notes ?? null);
    return { content: [{ type: 'text', text: `Food logged: ${params.meal} at ${new Date().toLocaleString()} (id: ${result.lastInsertRowid})` }] };
  });

  server.tool('get_progress_summary', 'Get multi-week progress: workout frequency, top exercises', {
    weeks: z.number().default(4),
  }, async (params) => {
    const days = params.weeks * 7;
    const workoutFreq = db.prepare(`SELECT date(logged_at) as day, COUNT(*) as exercises_logged FROM workout_logs WHERE logged_at >= datetime('now', '-${days} days') GROUP BY date(logged_at) ORDER BY day DESC`).all();
    const topExercises = db.prepare(`SELECT exercise, COUNT(*) as sessions FROM workout_logs WHERE logged_at >= datetime('now', '-${days} days') GROUP BY exercise ORDER BY sessions DESC LIMIT 10`).all();
    return { content: [{ type: 'text', text: JSON.stringify({ period: `Last ${params.weeks} weeks`, total_workout_days: workoutFreq.length, workout_frequency_by_day: workoutFreq, top_exercises: topExercises }, null, 2) }] };
  });
}

// ── Express app ───────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ── OAuth endpoints ───────────────────────────────────────────────────────────

app.get('/.well-known/oauth-authorization-server', (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  res.json({
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
  });
});

app.get('/authorize', (req, res) => {
  const { redirect_uri, state, code_challenge, code_challenge_method, client_id } = req.query;

  const params = new URLSearchParams({ redirect_uri, state, code_challenge, code_challenge_method: code_challenge_method || 'S256' }).toString();

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Connect Your Personal Trainer</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #0a0a0a;
      color: #fff;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .card {
      background: #141414;
      border: 1px solid #222;
      border-radius: 20px;
      padding: 40px 36px;
      max-width: 420px;
      width: 100%;
    }
    .icon {
      font-size: 48px;
      margin-bottom: 20px;
      display: block;
    }
    h1 {
      font-size: 26px;
      font-weight: 700;
      line-height: 1.2;
      margin-bottom: 12px;
    }
    .subtitle {
      color: #888;
      font-size: 15px;
      line-height: 1.5;
      margin-bottom: 32px;
    }
    .steps {
      list-style: none;
      margin-bottom: 36px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .steps li {
      display: flex;
      align-items: flex-start;
      gap: 14px;
    }
    .step-num {
      background: #1e1e1e;
      border: 1px solid #333;
      border-radius: 50%;
      width: 28px;
      height: 28px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 13px;
      font-weight: 600;
      color: #fff;
      flex-shrink: 0;
      margin-top: 1px;
    }
    .step-text {
      font-size: 15px;
      color: #ccc;
      line-height: 1.4;
    }
    .step-text strong {
      color: #fff;
    }
    button {
      width: 100%;
      padding: 16px;
      background: #fff;
      color: #000;
      border: none;
      border-radius: 12px;
      font-size: 16px;
      font-weight: 700;
      cursor: pointer;
      transition: opacity 0.15s;
    }
    button:hover { opacity: 0.9; }
    .fine-print {
      text-align: center;
      color: #444;
      font-size: 12px;
      margin-top: 16px;
    }
  </style>
</head>
<body>
  <div class="card">
    <span class="icon">🏋️</span>
    <h1>Ready to meet your Coach?</h1>
    <p class="subtitle">Your AI personal trainer lives inside Claude. Here's how it works:</p>

    <ul class="steps">
      <li>
        <div class="step-num">1</div>
        <div class="step-text"><strong>Tell Coach about yourself</strong> — your goals, equipment, and training history. The more you share, the better your program.</div>
      </li>
      <li>
        <div class="step-num">2</div>
        <div class="step-text"><strong>Get a custom program</strong> — Coach builds a plan around your schedule and equipment, and adjusts it as you progress.</div>
      </li>
      <li>
        <div class="step-num">3</div>
        <div class="step-text"><strong>Train and log as you go</strong> — just talk. Coach tracks your workouts and food automatically during the conversation.</div>
      </li>
    </ul>

    <form method="POST" action="/authorize?${params}">
      <button type="submit">Let's go →</button>
    </form>
    <p class="fine-print">No subscription. No account. Just Coach.</p>
  </div>
</body>
</html>`);
});

app.post('/authorize', (req, res) => {
  const { redirect_uri, state, code_challenge, code_challenge_method } = req.query;

  if (!redirect_uri) {
    res.status(400).send('Missing redirect_uri');
    return;
  }

  const code = randomBytes(32).toString('hex');
  db.prepare('INSERT INTO oauth_codes (code, code_challenge, code_challenge_method, redirect_uri) VALUES (?, ?, ?, ?)')
    .run(code, code_challenge ?? null, code_challenge_method ?? 'S256', redirect_uri);

  const url = new URL(redirect_uri);
  url.searchParams.set('code', code);
  if (state) url.searchParams.set('state', state);
  res.redirect(url.toString());
});

app.post('/token', (req, res) => {
  const { code, code_verifier, grant_type } = req.body;

  if (grant_type !== 'authorization_code') {
    res.status(400).json({ error: 'unsupported_grant_type' });
    return;
  }

  const stored = db.prepare('SELECT * FROM oauth_codes WHERE code = ?').get(code);
  if (!stored) {
    res.status(400).json({ error: 'invalid_grant' });
    return;
  }

  // Verify PKCE (S256)
  if (stored.code_challenge) {
    const hash = createHash('sha256').update(code_verifier ?? '').digest('base64url');
    if (hash !== stored.code_challenge) {
      res.status(400).json({ error: 'invalid_grant' });
      return;
    }
  }

  // Expire codes older than 10 minutes and delete used code
  db.prepare('DELETE FROM oauth_codes WHERE created_at < unixepoch() - 600').run();
  db.prepare('DELETE FROM oauth_codes WHERE code = ?').run(code);

  const token = randomBytes(32).toString('hex');
  db.prepare('INSERT INTO oauth_tokens (token) VALUES (?)').run(token);

  res.json({
    access_token: token,
    token_type: 'Bearer',
    expires_in: 365 * 24 * 3600,
  });
});

// ── MCP routes (auth required) ────────────────────────────────────────────────

function makeMcpServer() {
  const server = new McpServer(
    { name: 'personal-trainer', version: '1.0.0' },
    { instructions: 'Call start_session at the beginning of every conversation before saying anything to the user.' }
  );
  registerTools(server);
  return server;
}

app.post('/mcp', requireAuth, async (req, res) => {
  const server = makeMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get('/mcp', requireAuth, async (req, res) => {
  const server = makeMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  await transport.handleRequest(req, res);
});

app.delete('/mcp', requireAuth, async (req, res) => {
  const server = makeMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  await transport.handleRequest(req, res);
});

app.get('/health', (_, res) => res.json({ status: 'ok', service: 'personal-trainer-mcp' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Personal Trainer MCP running on port ${PORT}`));
