// Re-export from canonical types location
export type { Language, TracingLevel, FrameworkSupport } from "../types/index.js";

export const supportedFrameworks: import("../types/index.js").FrameworkSupport[] = [
  { framework: "Magento 2",   language: "php",        apiEndpoints: true,  controllers: true,  dbModels: true,  supportedORMs: ["Magento ORM"],                   tracingLevel: "full"    },
  { framework: "NestJS",      language: "typescript", apiEndpoints: true,  controllers: true,  dbModels: true,  supportedORMs: ["Prisma", "TypeORM"],             tracingLevel: "full"    },
  { framework: "Laravel",     language: "php",        apiEndpoints: true,  controllers: true,  dbModels: true,  supportedORMs: ["Eloquent"],                      tracingLevel: "full"    },
  { framework: "Express",     language: "javascript", apiEndpoints: true,  controllers: true,  dbModels: true,  supportedORMs: ["Prisma", "TypeORM", "Mongoose"], tracingLevel: "partial" },
  { framework: "Fastify",     language: "javascript", apiEndpoints: true,  controllers: true,  dbModels: true,  supportedORMs: ["Prisma", "TypeORM", "Mongoose"], tracingLevel: "partial" },
  { framework: "Spring Boot", language: "java",       apiEndpoints: true,  controllers: true,  dbModels: true,  supportedORMs: ["JPA", "Hibernate"],              tracingLevel: "partial" },
  { framework: "FastAPI",     language: "python",     apiEndpoints: true,  controllers: false, dbModels: true,  supportedORMs: ["SQLAlchemy"],                    tracingLevel: "partial" },
  { framework: "Django",      language: "python",     apiEndpoints: true,  controllers: false, dbModels: true,  supportedORMs: ["Django ORM"],                    tracingLevel: "partial" },
];
