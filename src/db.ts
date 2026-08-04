import { PrismaClient } from "@prisma/client";

// Cliente único de Prisma para todo el proceso (patrón estándar en
// Node/Express — evitar abrir un pool de conexiones nuevo por request).
export const db = new PrismaClient();
