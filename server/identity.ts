import { caseFold } from 'unicode-case-folding';
/** Keep case-insensitive account conflict checks compatible with Python str.casefold. */
export const nameKey = (value: string): string => caseFold(value);
