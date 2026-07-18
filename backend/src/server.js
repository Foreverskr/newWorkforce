import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

import { notFoundHandler, errorHandler } from './middleware/errorHandler.js';

import authRoutes from './routes/auth.routes.js';
import employeesRoutes from './routes/employees.routes.js';
import leavesRoutes from './routes/leaves.routes.js';
import attendanceRoutes from './routes/attendance.routes.js';
import scheduleRoutes, { templateRouter } from './routes/schedule.routes.js';
import driversRoutes from './routes/drivers.routes.js';
import healthRoutes from './routes/health.routes.js';
import analyticsRoutes from './routes/analytics.routes.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

app.use('/api/auth', authRoutes);
app.use('/api/employees', employeesRoutes);
app.use('/api/leaves', leavesRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/shift-templates', templateRouter);
app.use('/api/schedule', scheduleRoutes);
app.use('/api/drivers', driversRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/health', healthRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

app.listen(PORT, () => console.log(`✅  Attendance API running on http://localhost:${PORT}`));
