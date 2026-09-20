import { PrismaClient } from "@prisma/client";

/**
 * Prisma singleton.
 *
 * Node module caching already gives us one instance per process in production.
 * The globalThis dance exists for dev servers that hot-reload this module,
 * where a fresh PrismaClient per reload exhausts the connection pool within a
 * few minutes of editing.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
