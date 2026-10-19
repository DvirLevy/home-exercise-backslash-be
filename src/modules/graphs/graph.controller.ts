import type { Request, Response } from 'express';
import { parseIfMatch, versionToEtag } from '../../http/etag';
import { ValidationError } from '../../http/errors';
import { parseJsonBuffer } from './ingestion/upload-parser';
import { presentGraph, presentSummary, presentWriteResult } from './graph.presenter';
import type { GraphService } from './graph.service';

function uploadedContent(req: Request): unknown {
  if (!req.file) {
    throw new ValidationError('A JSON file is required', [{ path: 'file', message: 'Required' }]);
  }
  return parseJsonBuffer(req.file.buffer);
}

/** Routes use `validate()` before these handlers, so params and body are already parsed. */
export class GraphController {
  constructor(private readonly service: GraphService) {}

  create = async (req: Request, res: Response): Promise<void> => {
    const { name } = req.body as { name: string };
    const { summary, placeholders } = await this.service.create(name, uploadedContent(req));

    res
      .status(201)
      .location(`${req.baseUrl}/${summary.id}`)
      .set('ETag', versionToEtag(summary.version))
      .json(presentWriteResult(summary, placeholders));
  };

  list = async (_req: Request, res: Response): Promise<void> => {
    const graphs = await this.service.list();
    res.json(graphs.map(presentSummary));
  };

  get = async (req: Request, res: Response): Promise<void> => {
    const graph = await this.service.get(req.params.id as string);
    res.set('ETag', versionToEtag(graph.version)).json(presentGraph(graph));
  };

  replace = async (req: Request, res: Response): Promise<void> => {
    const { name } = req.body as { name?: string };
    const { summary, placeholders } = await this.service.replace(req.params.id as string, {
      content: uploadedContent(req),
      name,
      expectedVersion: parseIfMatch(req.get('If-Match')),
    });

    res.set('ETag', versionToEtag(summary.version)).json(presentWriteResult(summary, placeholders));
  };

  rename = async (req: Request, res: Response): Promise<void> => {
    const { name } = req.body as { name: string };
    const summary = await this.service.rename(req.params.id as string, name);
    res.set('ETag', versionToEtag(summary.version)).json(presentSummary(summary));
  };

  delete = async (req: Request, res: Response): Promise<void> => {
    await this.service.delete(req.params.id as string);
    res.status(204).end();
  };
}
