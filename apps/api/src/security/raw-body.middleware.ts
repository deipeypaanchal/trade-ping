import { Request, Response, NextFunction } from 'express';

export function captureRawBody(req: Request & { rawBody?: string }, _res: Response, next: NextFunction) {
  if (typeof req.body === 'object' && req.body) {
    req.rawBody = JSON.stringify(req.body, Object.keys(req.body).sort());
  }
  next();
}
