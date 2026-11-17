import mapboxgl from 'https://cdn.jsdelivr.net/npm/mapbox-gl@2.15.0/+esm';
import * as d3 from 'https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm';

mapboxgl.accessToken = 'pk.eyJ1IjoibTF0YWtldWMiLCJhIjoiY213a2Q4Z3BmMGRuZTMwcHZ4cDc0ZW5oaSJ9.iF4qhHyAvicJBYTIPg41uA';

const map = new mapboxgl.Map({
    container: 'map',
    style: 'mapbox://styles/mapbox/light-v11',
    center: [-71.09415, 42.36027],
    zoom: 12,
    minZoom: 5,
    maxZoom: 18
});

map.addControl(new mapboxgl.NavigationControl(), 'top-left');

const svg = d3.select('#map svg');
const timeSlider = document.getElementById('time-slider');
const selectedTime = document.getElementById('selected-time');
const anyTimeLabel = document.getElementById('any-time');
const status = document.getElementById('status');

const departuresByMinute = Array.from({ length: 1440 }, () => []);
const arrivalsByMinute = Array.from({ length: 1440 }, () => []);

const stationFlow = d3.scaleQuantize()
    .domain([0, 1])
    .range([0, 0.5, 1]);

function formatTime(minutes) {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    const period = hours >= 12 ? 'PM' : 'AM';
    const hour12 = hours % 12 || 12;

    return `${hour12}:${String(mins).padStart(2, '0')} ${period}`;
}

function minutesSinceMidnight(date) {
    return date.getHours() * 60 + date.getMinutes();
}

function getCoords(station) {
    const longitude = Number(station.lon ?? station.Long);
    const latitude = Number(station.lat ?? station.Lat);

    return map.project([longitude, latitude]);
}

function filterByMinute(buckets, minute) {
    if (minute === -1) {
        return buckets.flat();
    }

    const results = [];

    for (let offset = -60; offset <= 60; offset++) {
        const index = (minute + offset + 1440) % 1440;
        results.push(...buckets[index]);
    }

    return results;
}

function computeStationTraffic(stations, timeFilter = -1) {
    const departures = d3.rollup(
        filterByMinute(departuresByMinute, timeFilter),
        values => values.length,
        trip => trip.start_station_id
    );

    const arrivals = d3.rollup(
        filterByMinute(arrivalsByMinute, timeFilter),
        values => values.length,
        trip => trip.end_station_id
    );

    return stations.map(station => {
        const id = station.short_name ?? station.Number;

        return {
            ...station,
            arrivals: arrivals.get(id) ?? 0,
            departures: departures.get(id) ?? 0,
            totalTraffic: (arrivals.get(id) ?? 0) + (departures.get(id) ?? 0)
        };
    });
}

function addBikeLanes(id, url, color = '#16a34a') {
    map.addSource(id, {
        type: 'geojson',
        data: url
    });

    map.addLayer({
        id: `${id}-layer`,
        type: 'line',
        source: id,
        paint: {
            'line-color': color,
            'line-width': 3,
            'line-opacity': 0.65
        }
    });
}

async function addCambridgeBikeLanes() {
    const query = `[out:json][timeout:30];(way["highway"="cycleway"](42.345,-71.165,42.415,-71.065);way["cycleway"](42.345,-71.165,42.415,-71.065););out geom;`;

    const response = await fetch(
        'https://overpass.kumi.systems/api/interpreter',
        {
            method: 'POST',
            body: new URLSearchParams({ data: query })
        }
    );

    if (!response.ok) {
        throw new Error('Cambridge bike lane request failed');
    }

    const data = await response.json();

    const features = data.elements
        .filter(element => element.geometry?.length > 1)
        .map(element => ({
            type: 'Feature',
            properties: element.tags ?? {},
            geometry: {
                type: 'LineString',
                coordinates: element.geometry.map(point => [
                    point.lon,
                    point.lat
                ])
            }
        }));

    map.addSource('cambridge-bike-lanes', {
        type: 'geojson',
        data: {
            type: 'FeatureCollection',
            features
        }
    });

    map.addLayer({
        id: 'cambridge-bike-lanes-layer',
        type: 'line',
        source: 'cambridge-bike-lanes',
        paint: {
            'line-color': '#16a34a',
            'line-width': 3,
            'line-opacity': 0.65
        }
    });
}

map.on('load', async () => {
    addBikeLanes(
        'boston-bike-lanes',
        'https://bostonopendata-boston.opendata.arcgis.com/datasets/boston::existing-bike-network-2022.geojson'
    );

    addCambridgeBikeLanes().catch(error => {
        console.warn('Cambridge bike lanes unavailable:', error);
    });

    try {
        const [jsonData, trips] = await Promise.all([
            d3.json('https://dsc106.com/labs/lab07/data/bluebikes-stations.json'),
            d3.csv(
                'https://dsc106.com/labs/lab07/data/bluebikes-traffic-2024-03.csv',
                trip => {
                    const start = new Date(trip.started_at.replace(' ', 'T'));
                    const end = new Date(trip.ended_at.replace(' ', 'T'));

                    return {
                        ...trip,
                        started_at: start,
                        ended_at: end
                    };
                }
            )
        ]);

        for (const trip of trips) {
            if (!Number.isNaN(trip.started_at.getTime())) {
                departuresByMinute[minutesSinceMidnight(trip.started_at)].push(trip);
            }

            if (!Number.isNaN(trip.ended_at.getTime())) {
                arrivalsByMinute[minutesSinceMidnight(trip.ended_at)].push(trip);
            }
        }

        const rawStations = jsonData.data.stations;
        const stations = computeStationTraffic(rawStations);

        const radiusScale = d3.scaleSqrt()
            .domain([0, d3.max(stations, station => station.totalTraffic) || 1])
            .range([0, 25]);

        const circles = svg
            .selectAll('circle')
            .data(stations, station => station.short_name ?? station.Number)
            .join('circle')
            .attr('r', station => radiusScale(station.totalTraffic))
            .style('--departure-ratio', station =>
                station.totalTraffic
                    ? stationFlow(station.departures / station.totalTraffic)
                    : 0.5
            );

        circles.append('title');

        function updatePositions() {
            circles
                .attr('cx', station => getCoords(station).x)
                .attr('cy', station => getCoords(station).y);
        }

        function updateScatterPlot(timeFilter) {
            const filteredStations = computeStationTraffic(
                rawStations,
                timeFilter
            );

            radiusScale.range(
                timeFilter === -1 ? [0, 25] : [0, 50]
            );

            circles
                .data(filteredStations, station => station.short_name ?? station.Number)
                .attr('r', station => radiusScale(station.totalTraffic))
                .style('--departure-ratio', station =>
                    station.totalTraffic
                        ? stationFlow(station.departures / station.totalTraffic)
                        : 0.5
                )
                .select('title')
                .text(station => {
                    const name = station.name ?? station.NAME ?? 'Bike station';

                    return `${name}
${station.totalTraffic.toLocaleString()} trips
${station.departures.toLocaleString()} departures
${station.arrivals.toLocaleString()} arrivals`;
                });
        }

        function updateTimeDisplay() {
            const timeFilter = Number(timeSlider.value);

            if (timeFilter === -1) {
                selectedTime.textContent = '';
                anyTimeLabel.style.display = 'block';
            } else {
                selectedTime.textContent = formatTime(timeFilter);
                anyTimeLabel.style.display = 'none';
            }

            updateScatterPlot(timeFilter);
        }

        map.on('move', updatePositions);
        map.on('resize', updatePositions);

        timeSlider.addEventListener('input', updateTimeDisplay);

        updatePositions();
        updateTimeDisplay();

        status.textContent =
            `${stations.length.toLocaleString()} stations · ${trips.length.toLocaleString()} rides · March 2024`;

    } catch (error) {
        console.error(error);
        status.textContent = `Failed to load bike data: ${error.message}`;
    }
});
