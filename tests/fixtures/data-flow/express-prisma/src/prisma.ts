// Minimal Prisma client stand-in for the fixture.
export const prisma = {
  users: {
    findMany(): unknown {
      return [];
    },
  },
};
