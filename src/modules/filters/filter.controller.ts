import type { Request, Response } from 'express';
import { presentFilter, presentPreview } from './filter.presenter';
import type { FilterService } from './filter.service';

interface FilterBody {
  key: string;
  description?: string | null;
  definition: unknown;
}

/** Routes use `validate()` first, so params and body are already checked. */
export class FilterController {
  constructor(private readonly service: FilterService) {}

  list = async (req: Request, res: Response): Promise<void> => {
    const filters = await this.service.list(req.params.id as string);
    res.json(filters.map(presentFilter));
  };

  get = async (req: Request, res: Response): Promise<void> => {
    const filter = await this.service.get(req.params.id as string, req.params.key as string);
    res.json(presentFilter(filter));
  };

  create = async (req: Request, res: Response): Promise<void> => {
    const { key, description, definition } = req.body as FilterBody;
    const filter = await this.service.create(req.params.id as string, key, { description, definition });
    res.status(201).location(`${req.baseUrl}/${req.params.id}/filters/${key}`).json(presentFilter(filter));
  };

  replace = async (req: Request, res: Response): Promise<void> => {
    const { description, definition } = req.body as FilterBody;
    const filter = await this.service.replace(req.params.id as string, req.params.key as string, { description, definition });
    res.json(presentFilter(filter));
  };

  delete = async (req: Request, res: Response): Promise<void> => {
    await this.service.delete(req.params.id as string, req.params.key as string);
    res.status(204).end();
  };

  preview = async (req: Request, res: Response): Promise<void> => {
    const { definition } = req.body as FilterBody;
    res.json(presentPreview(await this.service.preview(req.params.id as string, definition)));
  };
}
