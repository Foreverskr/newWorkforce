import 'dotenv/config';

import express from 'express';
import cors from 'cors';

import { notFoundHandler, errorHandler } from './middleware/errorHandler.js';
import { requireAuth } from './middleware/authMiddleware.js';

import authRoutes from './routes/auth.routes.js';
import employeesRoutes from './routes/employees.routes.js';
import leavesRoutes from './routes/leaves.routes.js';
import attendanceRoutes from './routes/attendance.routes.js';
import scheduleRoutes, { templateRouter } from './routes/schedule.routes.js';
import driversRoutes from './routes/drivers.routes.js';
import healthRoutes from './routes/health.routes.js';
import analyticsRoutes from './routes/analytics.routes.js';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Public routes — no token required
app.use('/api/auth', authRoutes);
app.use('/api/health', healthRoutes);

// Everything below requires a valid, non-expired token
app.use('/api/employees', requireAuth, employeesRoutes);
app.use('/api/leaves', requireAuth, leavesRoutes);
app.use('/api/attendance', requireAuth, attendanceRoutes);
app.use('/api/shift-templates', requireAuth, templateRouter);
app.use('/api/schedule', requireAuth, scheduleRoutes);
app.use('/api/drivers', requireAuth, driversRoutes);
app.use('/api/analytics', requireAuth, analyticsRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

app.listen(PORT, () => console.log(`✅  Attendance API running on http://localhost:${PORT}`));