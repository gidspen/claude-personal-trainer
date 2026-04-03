import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { z } from 'zod';
import { DatabaseSync } from 'node:sqlite';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// ── Database ─────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || join(__dirname, 'trainer.db');
const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS profile (
    id INTEGER PRIMARY KEY DEFAULT 1,
    name TEXT,
    age INTEGER,
    weight_lbs REAL,
    height_inches REAL,
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
    heart_rate_avg INTEGER,
    heart_rate_max INTEGER,
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

  CREATE TABLE IF NOT EXISTS body_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    weight_lbs REAL,
    body_fat_pct REAL,
    resting_heart_rate INTEGER,
    notes TEXT,
    logged_at TEXT DEFAULT (datetime('now'))
  );
`);

// ── Tool registration ────────────────────────────────────────────────────────
// Called on every new McpServer instance (stateless pattern)

function registerTools(server) {

  server.tool('start_session', 'Call this at the start of every conversation. Returns onboarding questions if profile is incomplete, or full training context if ready.', {}, async () => {
    const profile = db.prepare('SELECT * FROM profile WHERE id = 1').get();

    const REQUIRED = [
      { field: 'name',                    question: "What's your name?" },
      { field: 'age',                     question: "How old are you?" },
      { field: 'weight_lbs',              question: "What's your current weight (in lbs)?" },
      { field: 'height_inches',           question: "How tall are you?" },
      { field: 'fitness_goal',            question: "What's your main fitness goal? (e.g. lose fat, build muscle, improve strength, general health)" },
      { field: 'training_days_per_week',  question: "How many days per week can you train?" },
      { field: 'session_duration_minutes',question: "How long is each session? (e.g. 45 min, 60 min, 90 min)" },
      { field: 'equipment',               question: "What equipment do you have access to? Be specific — squat rack, dumbbells, cables, bench, etc." },
      { field: 'training_history',        question: "How long have you been training and what have you mostly done?" },
      { field: 'preferred_style',         question: "Any preference on training style? Strength, hypertrophy, powerlifting, conditioning, circuits — or no preference?" },
      { field: 'injuries',                question: "Any injuries, pain, or movements you need to avoid?" },
    ];

    const missing = REQUIRED.filter(r => !profile || !profile[r.field]);

    if (missing.length > 0) {
      return { content: [{ type: 'text', text: JSON.stringify({
        status: 'needs_onboarding',
        instructions: 'Profile incomplete. You are a personal trainer onboarding a new client. Ask questions one at a time in a natural conversational tone — not as a list. Call update_profile after each answer before asking the next question. Once all questions are answered, build a workout program and save it with save_workout_plan.',
        next_question: missing[0].question,
        remaining_questions: missing.map(r => r.question),
        completed_fields: profile ? REQUIRED.filter(r => profile[r.field]).map(r => r.field) : [],
      }, null, 2) }] };
    }

    // Profile complete — return full training context + behavioral instructions
    const recentWorkouts = db.prepare(`SELECT * FROM workout_logs WHERE logged_at >= datetime('now', '-7 days') ORDER BY logged_at DESC LIMIT 30`).all();
    const todayExercises = db.prepare(`SELECT * FROM workout_logs WHERE date(logged_at) = date('now') ORDER BY logged_at`).all();
    const todayFood = db.prepare(`SELECT * FROM food_logs WHERE date(logged_at) = date('now') ORDER BY logged_at`).all();
    const latestMetrics = db.prepare(`SELECT * FROM body_metrics ORDER BY logged_at DESC LIMIT 1`).get();
    const plans = db.prepare(`SELECT * FROM workout_plans WHERE active = 1 ORDER BY day_of_week`).all();

    return { content: [{ type: 'text', text: JSON.stringify({
      status: 'ready',
      instructions: {
        role: 'You are Coach, a direct and knowledgeable personal trainer.',
        session_start: 'You now have the full context below. Greet the user by name, note what they did recently if anything, and ask what they want to do today.',
        programming: 'Design workouts based on the profile. Apply progressive overload — always check recent_workouts before prescribing weights or reps. Match exercises to available equipment.',
        during_workout: 'Walk through one exercise at a time. Do not dump the full workout upfront. Keep responses short and direct.',
        logging: 'Call log_exercise the moment the user says they finished anything — do not wait or ask permission. Log heart rate whenever they mention it. Log food when they mention eating. Log body weight when they mention it.',
        tone: 'Direct, not a cheerleader. If they are skipping sessions or eating poorly, name it plainly. No filler phrases.',
        plans: 'If no workout plans exist, build one based on the profile and save it with save_workout_plan before starting the session.',
      },
      profile,
      workout_plans: plans.map(p => ({ ...p, exercises: JSON.parse(p.exercises) })),
      recent_workouts_7_days: recentWorkouts,
      todays_exercises_so_far: todayExercises,
      todays_food_so_far: todayFood,
      latest_body_metrics: latestMetrics ?? null,
    }, null, 2) }] };
  });

  server.tool('get_profile', 'Get the user\'s fitness profile, goals, equipment, and injuries', {}, async () => {
    const profile = db.prepare('SELECT * FROM profile WHERE id = 1').get();
    if (!profile) return { content: [{ type: 'text', text: 'No profile set yet. Use update_profile to create one.' }] };
    return { content: [{ type: 'text', text: JSON.stringify(profile, null, 2) }] };
  });

  server.tool('update_profile', 'Update fitness profile — call this when user shares any info about themselves', {
    name: z.string().optional(),
    age: z.number().optional(),
    weight_lbs: z.number().optional(),
    height_inches: z.number().optional(),
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
      db.prepare(`INSERT INTO profile (id, name, age, weight_lbs, height_inches, fitness_goal, fitness_level, equipment, injuries, training_days_per_week, session_duration_minutes, preferred_style, training_history, notes, updated_at)
        VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`)
        .run(params.name ?? null, params.age ?? null, params.weight_lbs ?? null, params.height_inches ?? null,
          params.fitness_goal ?? null, params.fitness_level ?? 'intermediate',
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
    heart_rate_avg: z.number().optional().describe('Average HR — log whenever user mentions it'),
    heart_rate_max: z.number().optional().describe('Peak HR'),
    rpe: z.number().min(1).max(10).optional().describe('Rate of perceived exertion 1-10'),
    notes: z.string().optional(),
  }, async (params) => {
    const result = db.prepare(`INSERT INTO workout_logs (exercise, sets_completed, reps_per_set, weight_lbs, duration_minutes, heart_rate_avg, heart_rate_max, rpe, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(params.exercise, params.sets_completed ?? null, params.reps_per_set ?? null,
        params.weight_lbs ?? null, params.duration_minutes ?? null,
        params.heart_rate_avg ?? null, params.heart_rate_max ?? null,
        params.rpe ?? null, params.notes ?? null);
    return { content: [{ type: 'text', text: `Logged: ${params.exercise} at ${new Date().toLocaleString()} (id: ${result.lastInsertRowid})` }] };
  });

  server.tool('get_todays_workout_summary', 'Get everything logged today — exercises, food, and body metrics', {}, async () => {
    const exercises = db.prepare(`SELECT * FROM workout_logs WHERE date(logged_at) = date('now') ORDER BY logged_at`).all();
    const food = db.prepare(`SELECT * FROM food_logs WHERE date(logged_at) = date('now') ORDER BY logged_at`).all();
    const metrics = db.prepare(`SELECT * FROM body_metrics WHERE date(logged_at) = date('now') ORDER BY logged_at`).all();
    return { content: [{ type: 'text', text: JSON.stringify({
      date: new Date().toLocaleDateString(),
      exercises_logged: exercises.length,
      exercises,
      food_logged: food.length,
      total_calories_today: food.reduce((s, f) => s + (f.calories || 0), 0),
      total_protein_today_g: food.reduce((s, f) => s + (f.protein_g || 0), 0),
      food,
      body_metrics: metrics,
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

  server.tool('log_body_metrics', 'Log body weight, body fat %, or resting heart rate', {
    weight_lbs: z.number().optional(),
    body_fat_pct: z.number().optional(),
    resting_heart_rate: z.number().optional(),
    notes: z.string().optional(),
  }, async (params) => {
    db.prepare(`INSERT INTO body_metrics (weight_lbs, body_fat_pct, resting_heart_rate, notes) VALUES (?, ?, ?, ?)`)
      .run(params.weight_lbs ?? null, params.body_fat_pct ?? null, params.resting_heart_rate ?? null, params.notes ?? null);
    return { content: [{ type: 'text', text: `Body metrics logged at ${new Date().toLocaleString()}` }] };
  });

  server.tool('get_progress_summary', 'Get multi-week progress: weight trend, workout frequency, top exercises', {
    weeks: z.number().default(4),
  }, async (params) => {
    const days = params.weeks * 7;
    const workoutFreq = db.prepare(`SELECT date(logged_at) as day, COUNT(*) as exercises_logged FROM workout_logs WHERE logged_at >= datetime('now', '-${days} days') GROUP BY date(logged_at) ORDER BY day DESC`).all();
    const weightTrend = db.prepare(`SELECT date(logged_at) as day, weight_lbs FROM body_metrics WHERE weight_lbs IS NOT NULL AND logged_at >= datetime('now', '-${days} days') ORDER BY day DESC`).all();
    const topExercises = db.prepare(`SELECT exercise, COUNT(*) as sessions FROM workout_logs WHERE logged_at >= datetime('now', '-${days} days') GROUP BY exercise ORDER BY sessions DESC LIMIT 10`).all();
    return { content: [{ type: 'text', text: JSON.stringify({ period: `Last ${params.weeks} weeks`, total_workout_days: workoutFreq.length, workout_frequency_by_day: workoutFreq, weight_trend: weightTrend, top_exercises: topExercises }, null, 2) }] };
  });
}

// ── Express + stateless MCP handler ─────────────────────────────────────────

const app = express();
app.use(express.json());


// Stateless: new server + transport per request
app.post('/mcp', async (req, res) => {
  const server = new McpServer(
    { name: 'personal-trainer', version: '1.0.0' },
    { instructions: 'Call start_session at the beginning of every conversation before saying anything to the user.' }
  );
  registerTools(server);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get('/mcp', async (req, res) => {
  const server = new McpServer(
    { name: 'personal-trainer', version: '1.0.0' },
    { instructions: 'Call start_session at the beginning of every conversation before saying anything to the user.' }
  );
  registerTools(server);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  await transport.handleRequest(req, res);
});

app.delete('/mcp', async (req, res) => {
  const server = new McpServer(
    { name: 'personal-trainer', version: '1.0.0' },
    { instructions: 'Call start_session at the beginning of every conversation before saying anything to the user.' }
  );
  registerTools(server);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  await transport.handleRequest(req, res);
});

app.get('/health', (_, res) => res.json({ status: 'ok', service: 'personal-trainer-mcp' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Personal Trainer MCP running on port ${PORT}`));
