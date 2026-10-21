export const log = (msg: string, extra?: Record<string, string | number | boolean | null>) => {
  console.log(JSON.stringify({ msg, ...extra, t: new Date().toISOString() }));
};
