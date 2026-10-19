import type { Request, Response } from 'express';
import { toRouteRoles } from './query.parser';
import { presentRoutes } from './query.presenter';
import type { RouteQueryParams } from './query.schemas';
import type { QueryService } from './query.service';

export class QueryController {
  constructor(private readonly service: QueryService) {}

  routes = async (req: Request, res: Response): Promise<void> => {
    const roles = toRouteRoles(req.query as RouteQueryParams);
    res.json(presentRoutes(await this.service.routes(req.params.id as string, roles)));
  };
}
