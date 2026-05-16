"use client";

import { useEffect, useState } from "react";

type Listing = {
  id: number;
  name: string;
  price: number | null;
  katanaType: string;
  era: string | null;
  source: string;
  sourceUrl: string;
};

const FILTERS = ["ALL", "KATANA", "WAKIZASHI", "TANTO"];

export default function ListingTable() {
  const [listings, setListings] = useState<Listing[]>([]);

  const [loading, setLoading] = useState(true);

  const [filter, setFilter] = useState("ALL");

  const [sort, setSort] = useState("latest");

  const [search, setSearch] = useState("");

  async function fetchListings(type?: string) {
    setLoading(true);

    let url = "/api/market/listings";

    const params = new URLSearchParams();

    // filter
    if (type && type !== "ALL") {
      params.set("katanaType", type);
    }

    // sort
    if (sort !== "latest") {
      params.set("sort", sort);
    }

    // search
    if (search.trim()) {
      params.set("search", search);
    }

    const query = params.toString();

    if (query) {
      url += `?${query}`;
    }

    const res = await fetch(url);

    const data = await res.json();

    setListings(data.data);

    setLoading(false);
  }

  useEffect(() => {
    fetchListings(filter);
  }, [filter, sort, search]);

  return (
    <div>
      {/* Filters */}
      <div className="mb-4 flex gap-2">
        {FILTERS.map((item) => (
          <button
            key={item}
            onClick={() => setFilter(item)}
            className={`rounded border px-4 py-2 ${
              filter === item ? "bg-black text-white" : "bg-white"
            }`}
          >
            {item}
          </button>
        ))}
      </div>

      <div className="mb-4">
        <input
          type="text"
          placeholder="Search sword name..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full rounded border px-4 py-2"
        />
      </div>

      {/* Sort */}
      <div className="mb-6 flex gap-2">
        <button
          onClick={() => setSort("latest")}
          className={`rounded border px-4 py-2 ${
            sort === "latest" ? "bg-black text-white" : "bg-white"
          }`}
        >
          Latest
        </button>

        <button
          onClick={() => setSort("price_desc")}
          className={`rounded border px-4 py-2 ${
            sort === "price_desc" ? "bg-black text-white" : "bg-white"
          }`}
        >
          Price ↓
        </button>

        <button
          onClick={() => setSort("price_asc")}
          className={`rounded border px-4 py-2 ${
            sort === "price_asc" ? "bg-black text-white" : "bg-white"
          }`}
        >
          Price ↑
        </button>
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-lg border">
        <table className="w-full">
          <thead className="bg-gray-100">
            <tr>
              <th className="p-4 text-left">Name</th>

              <th className="p-4 text-left">Type</th>

              <th className="p-4 text-left">Era</th>

              <th className="p-4 text-left">Price</th>

              <th className="p-4 text-left">Source</th>
            </tr>
          </thead>

          <tbody>
            {loading ? (
              <tr>
                <td className="p-4">Loading...</td>
              </tr>
            ) : (
              listings.map((item) => (
                <tr key={item.id} className="border-t">
                  <td className="p-4">
                    <a
                      href={item.sourceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline"
                    >
                      {item.name}
                    </a>
                  </td>

                  <td className="p-4">{item.katanaType}</td>

                  <td className="p-4">{item.era ?? "-"}</td>

                  <td className="p-4">
                    ¥{item.price?.toLocaleString() ?? "-"}
                  </td>

                  <td className="p-4">{item.source}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
