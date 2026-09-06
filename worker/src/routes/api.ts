import { Hono } from 'hono';
import type { AppEnv } from '../context';
import { chatRouter } from './api/chat';
import { charactersRouter } from './api/characters';
import { stylesRouter } from './api/styles';
import { modulesRouter } from './api/modules';
import { keysRouter } from './api/keys';
import { profileRouter } from './api/profile';
import { importRouter } from './api/import';
import { adminRouter } from './api/admin';
import { pagesRouter } from './api/pages';

export const apiRouter = new Hono<AppEnv>();

apiRouter.route('/chat', chatRouter);
apiRouter.route('/characters', charactersRouter);
apiRouter.route('/styles', stylesRouter);
apiRouter.route('/modules', modulesRouter);
apiRouter.route('/keys', keysRouter);
apiRouter.route('/profile', profileRouter);
apiRouter.route('/import', importRouter);
apiRouter.route('/admin', adminRouter);

// 페이지 진입 데이터(/api/me, /api/home, /api/user/:id) — 루트에 직접 마운트.
apiRouter.route('/', pagesRouter);
