// Stand-in TypeORM repository whose `find` is the curated DB read method.
export const repo = {
  find(): unknown[] {
    return [];
  },
};
