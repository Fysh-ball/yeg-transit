#!/bin/sh
# Rebuild server/places.json: named non-residential places in Edmonton from one Overpass fetch.
# Run from the repo root, then deploy. Mirrors go down; try overpass-api.de if kumi fails.
set -e
B=53.35,-113.9,53.75,-113.15
Q="[out:json][timeout:170];(nwr[name][amenity]($B);nwr[name][shop]($B);nwr[name][leisure]($B);nwr[name][tourism]($B);nwr[name][healthcare]($B);nwr[name][office]($B););out center tags;"
mkdir -p data/osm
curl -sf -m200 -A 'YEGBus/1 (support@yegbus.com)' --data-urlencode "data=$Q" -o data/osm/pois.json "${1:-https://overpass.kumi.systems/api/interpreter}"
jq -c '[.elements[] | {n: .tags.name, k: (.tags.amenity // .tags.shop // .tags.leisure // .tags.tourism // .tags.healthcare // .tags.office), s: ([.tags["addr:housenumber"], .tags["addr:street"]] | map(select(.)) | join(" ")), lat: (.lat // .center.lat), lon: (.lon // .center.lon)} | select(.lat and (.k | IN("parking", "parking_entrance", "parking_space", "atm", "vending_machine", "bench", "waste_basket", "bicycle_parking", "post_box", "recycling", "toilets", "bus_station", "taxi") | not)) | [.n, (if .s == "" then (.k | gsub("_"; " ")) else .s end), ((.lat * 1e5 | round) / 1e5), ((.lon * 1e5 | round) / 1e5), .k]] | unique_by([.[0], (.[2] * 1e3 | round), (.[3] * 1e3 | round)])' data/osm/pois.json > server/places.json
jq length server/places.json
