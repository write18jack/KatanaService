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

  async function fetchListings(type?: string) {
    setLoading(true);

    let url = "/api/market/listings";

    if (type && type !== "ALL") {
      url += `?katanaType=${type}`;
    }

    const res = await fetch(url);

    const data = await res.json();

    setListings(data.data);

    setLoading(false);
  }

  useEffect(() => {
    fetchListings(filter);
  }, [filter]);

  return (
    <div>
      {/* Filters */}
      <div className="mb-6 flex gap-2">
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
