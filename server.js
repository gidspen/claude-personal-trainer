import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { z } from 'zod';
import db from './db.js';

const app = express();
app.use(express.json());

const MCP_SECRET = process.env.MCP_SECRET;
if (!MCP_SECRET) {
  console.error('ERROR: MCP_SECRET env var is not set. Server will reject all requests.');
}

app.use((req, res, next) => {
  if (req.path === '/health') return next();
  const auth = req.headers['authorization'];
  if (!MCP_SECRET || auth !== `Bearer ${MCP_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// ── MCP Server ──────────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'personal-trainer',
  version: '1.0.0',
});

// ── Tools ───────────────────────────────────────────────────────────────────

server.tool(
  'get_profile',
  'Get the user\'s fitness profile, goals, and notes',
  {},
  async () => {
    const profile = db.prepare('SELECT * FROM profile WHERE id = 1').get();
    if (!profile) {
      return { content: [{ type: 'text', text: 'No profile set yet. Use update_profile to create one.' }] };
    }
    return { content: [{ type: 'text', text: JSON.stringify(profile, null, 2) }] };
  }
);

server.tool(
  'update_profile',
  'Update the user\'s fitness profile and goals',
  {
    name: z.string().optional(),
    age: z.number().optional(),
    weight_lbs: z.number().optional(),
    height_inches: z.number().optional(),
    fitness_goal: z.string().optional().describe('e.g. "lose fat, build muscle, improve endurance"'),
    fitness_level: z.enum(['beginner', 'intermediate', 'advanced']).optional(),
    notes: z.string().optional().describe('Any other relevant info: injuries, preferences, schedule'),
  },
  async (params) => {
    const existing = db.prepare('SELECT * FROM profile WHERE id = 1').get();
    if (!existing) {
      db.prepare(`
        INSERT INTO profile (id, name, age, weight_lbs, height_inches, fitness_goal, fitness_level, notes, updated_at)
        VALUES (1, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(
        params.name ?? null,
        params.age ?? null,
        params.weight_lbs ?? null,
        params.height_inches ?? null,
        params.fitness_goal ?? null,
        params.fitness_level ?? 'intermediate',
        params.notes ?? null
      );
    } else {
      const fields = [];
      const values = [];
      for (const [key, val] of Object.entries(params)) {
        if (val !== undefined) {
          fields.push(`${key} = ?`);
          values.push(val);
        }
      }
      fields.push("updated_at = datetime('now')");
      if (fields.length > 1) {
        db.prepare(`UPDATE profile SET ${fields.join(', ')} WHERE id = 1`).run(...values);
      }
    }
    const updated = db.prepare('SELECT * FROM profile WHERE id = 1').get();
    return { content: [{ type: 'text', text: `Profile updated:\n${JSON.stringify(updated, null, 2)}` }] };
  }
);

server.tool(
  'get_workout_plans',
  'Get all active workout plans',
  {},
  async () => {
    const plans = db.prepare('SELECT * FROM workout_plans WHERE active = 1 ORDER BY day_of_week').all();
    if (!plans.length) {
      return { content: [{ type: 'text', text: 'No workout plans saved yet.' }] };
    }
    const formatted = plans.map(p => ({
      ...p,
      exercises: JSON.parse(p.exercises),
    }));
    return { content: [{ type: 'text', text: JSON.stringify(formatted, null, 2) }] };
  }
);

server.tool(
  'save_workout_plan',
  'Save or update a workout plan for a specific day or named routine',
  {
    name: z.string().describe('e.g. "Push Day", "Monday Legs", "Full Body A"'),
    day_of_week: z.string().optional().describe('e.g. "Monday", "Tuesday" or "Any"'),
    exercises: z.array(z.object({
      name: z.string(),
      sets: z.number(),
      reps: z.string().describe('e.g. "10", "8-12", "AMRAP"'),
      weight_note: z.string().optional().describe('e.g. "bodyweight", "135 lbs", "RPE 7"'),
      rest_seconds: z.number().optional(),
      notes: z.string().optional(),
    })).describe('List of exercises in this workout'),
  },
  async (params) => {
    db.prepare(`
      INSERT INTO workout_plans (name, day_of_week, exercises)
      VALUES (?, ?, ?)
    `).run(params.name, params.day_of_week ?? null, JSON.stringify(params.exercises));
    return { content: [{ type: 'text', text: `Workout plan "${params.name}" saved.` }] };
  }
);

server.tool(
  'log_exercise',
  'Log a completed exercise or set. Call once per exercise after user completes it.',
  {
    exercise: z.string().describe('Exercise name, e.g. "Back Squat", "Pull-up"'),
    sets_completed: z.number().optional(),
    reps_per_set: z.string().optional().describe('e.g. "10,10,8" or "10" if all sets equal'),
    weight_lbs: z.number().optional(),
    duration_minutes: z.number().optional(),
    heart_rate_avg: z.number().optional().describe('Average HR during exercise if user provides it'),
    heart_rate_max: z.number().optional().describe('Peak HR during exercise if user provides it'),
    rpe: z.number().min(1).max(10).optional().describe('Rate of perceived exertion 1-10'),
    notes: z.string().optional(),
  },
  async (params) => {
    const result = db.prepare(`
      INSERT INTO workout_logs (exercise, sets_completed, reps_per_set, weight_lbs, duration_minutes, heart_rate_avg, heart_rate_max, rpe, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      params.exercise,
      params.sets_completed ?? null,
      params.reps_per_set ?? null,
      params.weight_lbs ?? null,
      params.duration_minutes ?? null,
      params.heart_rate_avg ?? null,
      params.heart_rate_max ?? null,
      params.rpe ?? null,
      params.notes ?? null
    );
    return { content: [{ type: 'text', text: `Logged: ${params.exercise} at ${new Date().toLocaleString()} (id: ${result.lastInsertRowid})` }] };
  }
);

server.tool(
  'get_recent_workouts',
  'Get recent workout logs to see what has been done and when',
  {
    days: z.number().default(14).describe('How many days of history to retrieve'),
    exercise: z.string().optional().describe('Filter by specific exercise name'),
  },
  async (params) => {
    let query = `SELECT * FROM workout_logs WHERE logged_at >= datetime('now', '-${params.days} days')`;
    const args = [];
    if (params.exercise) {
      query += ' AND exercise LIKE ?';
      args.push(`%${params.exercise}%`);
    }
    query += ' ORDER BY logged_at DESC LIMIT 100';
    const logs = db.prepare(query).all(...args);
    if (!logs.length) {
      return { content: [{ type: 'text', text: `No workouts logged in the last ${params.days} days.` }] };
    }
    return { content: [{ type: 'text', text: JSON.stringify(logs, null, 2) }] };
  }
);

server.tool(
  'get_todays_workout_summary',
  'Get everything logged today — exercises, food, and body metrics',
  {},
  async () => {
    const exercises = db.prepare(`SELECT * FROM workout_logs WHERE date(logged_at) = date('now') ORDER BY logged_at`).all();
    const food = db.prepare(`SELECT * FROM food_logs WHERE date(logged_at) = date('now') ORDER BY logged_at`).all();
    const metrics = db.prepare(`SELECT * FROM body_metrics WHERE date(logged_at) = date('now') ORDER BY logged_at`).all();

    const totalCalories = food.reduce((sum, f) => sum + (f.calories || 0), 0);
    const totalProtein = food.reduce((sum, f) => sum + (f.protein_g || 0), 0);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          date: new Date().toLocaleDateString(),
          exercises_logged: exercises.length,
          exercises,
          food_logged: food.length,
          total_calories_today: totalCalories,
          total_protein_today_g: totalProtein,
          food,
          body_metrics: metrics,
        }, null, 2)
      }]
    };
  }
);

server.tool(
  'log_food',
  'Log a meal or food item',
  {
    meal: z.string().describe('Description of what was eaten, e.g. "chicken breast with rice and broccoli"'),
    calories: z.number().optional(),
    protein_g: z.number().optional(),
    carbs_g: z.number().optional(),
    fat_g: z.number().optional(),
    notes: z.string().optional(),
  },
  async (params) => {
    const result = db.prepare(`
      INSERT INTO food_logs (meal, calories, protein_g, carbs_g, fat_g, notes)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      params.meal,
      params.calories ?? null,
      params.protein_g ?? null,
      params.carbs_g ?? null,
      params.fat_g ?? null,
      params.notes ?? null
    );
    return { content: [{ type: 'text', text: `Food logged: ${params.meal} at ${new Date().toLocaleString()} (id: ${result.lastInsertRowid})` }] };
  }
);

server.tool(
  'log_body_metrics',
  'Log body weight, body fat %, or resting heart rate',
  {
    weight_lbs: z.number().optional(),
    body_fat_pct: z.number().optional(),
    resting_heart_rate: z.number().optional(),
    notes: z.string().optional(),
  },
  async (params) => {
    db.prepare(`
      INSERT INTO body_metrics (weight_lbs, body_fat_pct, resting_heart_rate, notes)
      VALUES (?, ?, ?, ?)
    `).run(
      params.weight_lbs ?? null,
      params.body_fat_pct ?? null,
      params.resting_heart_rate ?? null,
      params.notes ?? null
    );
    return { content: [{ type: 'text', text: `Body metrics logged at ${new Date().toLocaleString()}` }] };
  }
);

server.tool(
  'get_progress_summary',
  'Get a multi-week progress summary: weight trend, volume trend, workout frequency',
  {
    weeks: z.number().default(4).describe('How many weeks of data to include'),
  },
  async (params) => {
    const days = params.weeks * 7;

    const workoutFreq = db.prepare(`
      SELECT date(logged_at) as day, COUNT(*) as exercises_logged
      FROM workout_logs
      WHERE logged_at >= datetime('now', '-${days} days')
      GROUP BY date(logged_at)
      ORDER BY day DESC
    `).all();

    const weightTrend = db.prepare(`
      SELECT date(logged_at) as day, weight_lbs
      FROM body_metrics
      WHERE weight_lbs IS NOT NULL AND logged_at >= datetime('now', '-${days} days')
      ORDER BY day DESC
    `).all();

    const caloriesTrend = db.prepare(`
      SELECT date(logged_at) as day, SUM(calories) as total_calories, SUM(protein_g) as total_protein
      FROM food_logs
      WHERE logged_at >= datetime('now', '-${days} days')
      GROUP BY date(logged_at)
      ORDER BY day DESC
    `).all();

    const topExercises = db.prepare(`
      SELECT exercise, COUNT(*) as sessions
      FROM workout_logs
      WHERE logged_at >= datetime('now', '-${days} days')
      GROUP BY exercise
      ORDER BY sessions DESC
      LIMIT 10
    `).all();

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          period: `Last ${params.weeks} weeks`,
          total_workout_days: workoutFreq.length,
          workout_frequency_by_day: workoutFreq,
          weight_trend: weightTrend,
          calories_trend: caloriesTrend,
          top_exercises: topExercises,
        }, null, 2)
      }]
    };
  }
);

// ── HTTP Transport ───────────────────────────────────────────────────────────

const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: () => Math.random().toString(36).slice(2),
});

app.post('/mcp', async (req, res) => {
  await transport.handleRequest(req, res, req.body);
});

app.get('/mcp', async (req, res) => {
  await transport.handleRequest(req, res);
});

app.delete('/mcp', async (req, res) => {
  await transport.handleRequest(req, res);
});

app.get('/health', (_, res) => res.json({ status: 'ok', service: 'personal-trainer-mcp' }));

await server.connect(transport);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Personal Trainer MCP server running on port ${PORT}`);
});
