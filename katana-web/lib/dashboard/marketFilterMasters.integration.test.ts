import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { getMarketFilterMasters } from "./marketFilterMasters";
import { resolveMarketFilters } from "./marketFilters";

/**
 * Master取得 + URL検証の統合テスト（ローカルdocker Postgres）。
 * 作成したMasterはafterAllで必ず削除する。
 */
describe("getMarketFilterMasters (integration, real Postgres)", () => {
  const suffix = randomUUID();
  let activeGradeId: string;
  let inactiveGradeId: string;

  beforeAll(async () => {
    const [active, inactive] = await Promise.all([
      prisma.grade.create({ data: { name: `テスト格付け(有効) ${suffix}` } }),
      prisma.grade.create({ data: { name: `テスト格付け(無効) ${suffix}`, isActive: false } }),
    ]);
    activeGradeId = active.id;
    inactiveGradeId = inactive.id;
  });

  afterAll(async () => {
    await prisma.grade.deleteMany({ where: { id: { in: [activeGradeId, inactiveGradeId] } } });
  });

  it("8種類すべてのMasterをid/nameのみで返す", async () => {
    const masters = await getMarketFilterMasters();

    expect(Object.keys(masters).sort()).toEqual(
      ["appraiserId", "categoryId", "gradeId", "makerId", "periodId", "provinceId", "rankId", "swordEraId"].sort(),
    );
    const option = masters.gradeId.find((o) => o.id === activeGradeId);
    expect(option).toEqual({ id: activeGradeId, name: `テスト格付け(有効) ${suffix}` });
  });

  it("isActive=falseのMasterは選択肢に含めない", async () => {
    const masters = await getMarketFilterMasters();
    expect(masters.gradeId.some((o) => o.id === inactiveGradeId)).toBe(false);
  });

  it("inactiveなMaster IDをURLで指定しても無効として扱いMarketFiltersに含めない", async () => {
    const masters = await getMarketFilterMasters();

    const { filters, invalidKeys } = resolveMarketFilters({ gradeId: inactiveGradeId }, masters);
    expect(filters).toEqual({});
    expect(invalidKeys).toEqual(["gradeId"]);

    const valid = resolveMarketFilters({ gradeId: activeGradeId }, masters);
    expect(valid.filters).toEqual({ gradeId: activeGradeId });
    expect(valid.invalidKeys).toEqual([]);
  });
});
