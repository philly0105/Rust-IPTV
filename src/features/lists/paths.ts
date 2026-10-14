export const LISTS_PATH = '/lists';

export const listPath = (id: string) => `${LISTS_PATH}/${encodeURIComponent(id)}`;
