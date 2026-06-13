/**
 * Framework-specific layer pattern configurations.
 * Each framework maps to regex patterns for the 5 trace layers + unknown.
 *
 * Requirements: 4.1
 */
import type { FrameworkLayerConfig } from "./framework-layer-types.js";

const NESTJS_CONFIG: FrameworkLayerConfig = {
  framework: "nestjs",
  layers: {
    api: [/@get/i, /@post/i, /@put/i, /@delete/i, /@patch/i, /endpoint/i],
    controller: [/\.controller\./i, /controller/i, /@controller/i],
    service: [/\.service\./i, /service/i, /@injectable/i],
    repository: [/\.repository\./i, /repository/i, /typeorm/i],
    model: [/\.entity\./i, /entity/i, /schema/i, /@entity/i],
    unknown: [],
  },
};

const SPRING_CONFIG: FrameworkLayerConfig = {
  framework: "spring",
  layers: {
    api: [/@requestmapping/i, /@getmapping/i, /@postmapping/i, /@putmapping/i, /@deletemapping/i],
    controller: [/@controller/i, /@restcontroller/i, /controller/i],
    service: [/@service/i, /service/i, /serviceimpl/i],
    repository: [/@repository/i, /repository/i, /jparepository/i, /crudrepository/i],
    model: [/@entity/i, /@table/i, /entity/i, /model/i],
    unknown: [],
  },
};

const LARAVEL_CONFIG: FrameworkLayerConfig = {
  framework: "laravel",
  layers: {
    api: [/route::/i, /api\.php/i, /web\.php/i],
    controller: [/controller/i, /http\/controllers/i],
    service: [/service/i, /action/i, /manager/i],
    repository: [/repository/i, /eloquent/i],
    model: [/model/i, /migration/i, /schema/i],
    unknown: [],
  },
};

const EXPRESS_CONFIG: FrameworkLayerConfig = {
  framework: "express",
  layers: {
    api: [/router\./i, /\.route\(/i, /\.get\(/i, /\.post\(/i, /\.put\(/i, /\.delete\(/i],
    controller: [/controller/i, /handler/i, /routes\//i],
    service: [/service/i, /middleware/i, /manager/i],
    repository: [/repository/i, /dao/i, /store/i],
    model: [/model/i, /schema/i, /mongoose/i],
    unknown: [],
  },
};

const DJANGO_CONFIG: FrameworkLayerConfig = {
  framework: "django",
  layers: {
    api: [/urls\.py/i, /urlpatterns/i, /path\(/i],
    controller: [/views\.py/i, /viewset/i, /apiview/i],
    service: [/service/i, /manager/i, /utils/i],
    repository: [/repository/i, /queryset/i, /managers\.py/i],
    model: [/models\.py/i, /model/i, /django\.db/i],
    unknown: [],
  },
};

const FASTAPI_CONFIG: FrameworkLayerConfig = {
  framework: "fastapi",
  layers: {
    api: [/router/i, /@app\./i, /endpoint/i, /routers\//i],
    controller: [/controller/i, /handler/i, /endpoints\//i],
    service: [/service/i, /manager/i, /business/i],
    repository: [/repository/i, /crud/i, /dao/i],
    model: [/model/i, /schema/i, /sqlalchemy/i, /pydantic/i],
    unknown: [],
  },
};

const NEXTJS_CONFIG: FrameworkLayerConfig = {
  framework: "nextjs",
  layers: {
    api: [/api\//i, /route\.ts/i, /route\.js/i, /pages\/api/i],
    controller: [/handler/i, /middleware/i, /page\.tsx/i],
    service: [/service/i, /lib\//i, /actions\//i],
    repository: [/repository/i, /dao/i, /prisma/i],
    model: [/model/i, /schema/i, /entity/i],
    unknown: [],
  },
};

const ASPNET_CONFIG: FrameworkLayerConfig = {
  framework: "aspnet",
  layers: {
    api: [/\[httpget\]/i, /\[httppost\]/i, /\[httpput\]/i, /\[httpdelete\]/i, /\[route\]/i],
    controller: [/controller/i, /controllers\//i, /apicontroller/i],
    service: [/service/i, /manager/i, /business/i],
    repository: [/repository/i, /dbcontext/i, /entityframework/i],
    model: [/model/i, /entity/i, /dto/i],
    unknown: [],
  },
};

/** Map of framework identifiers to their layer configurations. */
export const FRAMEWORK_LAYER_MAP: ReadonlyMap<string, FrameworkLayerConfig> = new Map<string, FrameworkLayerConfig>([
  ["nestjs", NESTJS_CONFIG],
  ["spring", SPRING_CONFIG],
  ["laravel", LARAVEL_CONFIG],
  ["express", EXPRESS_CONFIG],
  ["django", DJANGO_CONFIG],
  ["fastapi", FASTAPI_CONFIG],
  ["nextjs", NEXTJS_CONFIG],
  ["aspnet", ASPNET_CONFIG],
]);
