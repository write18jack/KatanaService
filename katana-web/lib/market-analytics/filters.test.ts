import { describe, expect, it } from "vitest";
import { marketFilterSql, marketFilterWhere } from "./filters";

describe("marketFilterWhere", () => {
  it("フィルタ未指定の場合は空のwhereを返す", () => {
    expect(marketFilterWhere({})).toEqual({});
  });

  it("指定されたフィルタのみwhereに含める", () => {
    expect(marketFilterWhere({ categoryId: "cat-1", provinceId: "prov-1" })).toEqual({
      categoryId: "cat-1",
      provinceId: "prov-1",
    });
  });

  it("8種すべて指定した場合すべてAND条件として含める", () => {
    const filters = {
      categoryId: "a",
      gradeId: "b",
      rankId: "c",
      periodId: "d",
      provinceId: "e",
      swordEraId: "f",
      makerId: "g",
      appraiserId: "h",
    };
    expect(marketFilterWhere(filters)).toEqual(filters);
  });
});

describe("marketFilterSql", () => {
  it("フィルタ未指定の場合は空のSQL断片を返す", () => {
    const sql = marketFilterSql({});
    expect(sql.values).toEqual([]);
    expect(sql.text.trim()).toBe("");
  });

  it("単一フィルタはparameterized bindとして組み立てる（文字列埋め込みをしない）", () => {
    const sql = marketFilterSql({ categoryId: "cat-1" });
    expect(sql.values).toEqual(["cat-1"]);
    expect(sql.text).toContain('p."categoryId"');
    expect(sql.text).not.toContain("cat-1");
  });

  it("複数フィルタはAND接続で、値はすべてbind paramに入る", () => {
    const sql = marketFilterSql({ categoryId: "cat-1", gradeId: "grade-1", provinceId: "prov-1" });
    expect(sql.values).toEqual(["cat-1", "grade-1", "prov-1"]);
    expect(sql.text).toContain("AND");
    expect(sql.text).not.toContain("cat-1");
    expect(sql.text).not.toContain("grade-1");
    expect(sql.text).not.toContain("prov-1");
  });
});
