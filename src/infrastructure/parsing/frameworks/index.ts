/**
 * Framework-specific parsers.
 * Requirements: 14.1-14.8
 */
export { parseMagento2File, MAGENTO2_SUPPORT } from "./magento2.js";
export { parseNestJSFile, NESTJS_SUPPORT } from "./nestjs.js";
export { parseLaravelFile, LARAVEL_SUPPORT } from "./laravel.js";
export { parseExpressFile, EXPRESS_SUPPORT } from "./express.js";
export { parseFastifyFile, FASTIFY_SUPPORT } from "./fastify.js";
export { parseSpringBootFile, SPRING_BOOT_SUPPORT } from "./spring-boot.js";
export { parseFastAPIFile, FASTAPI_SUPPORT } from "./fastapi.js";
export { parseDjangoFile, DJANGO_SUPPORT } from "./django.js";
export { parseORMModels } from "./orm.js";
export { validateFrameworkSupport, assertValidFrameworkSupport } from "./framework-support.js";
export type { ValidationResult, ValidationError } from "./framework-support.js";
