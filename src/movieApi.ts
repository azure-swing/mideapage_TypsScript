// src/movieApiApp.ts (或者你的电影 API 文件名)
import { Hono } from 'hono';
import { Env, Movie, ActorInfoDb } // 确保类型定义正确
from './types';
import { getClientIp } from './auth'; // 假设 auth.ts 在同一目录
import { movieRowToDict, buildMovieWhereClauseAndParams, parseJsonField } // 假设 dbUtils.ts 在同一目录
from './dbUtils';
import { serveFileFromR2 } // 假设 r2Utils.ts 在同一目录
from './r2Utils';

export const movieApiApp = new Hono < { Bindings: Env } > ();

// GET /api_movies/items
movieApiApp.get('/items', async (c) => {
    const query = c.req.query();
    const startIndex = parseInt(query['StartIndex'] || '0', 10);
    const limit = parseInt(query['Limit'] || '100', 10);
    const sortBy = query['SortBy'] || 'PremiereDate';
    const sortOrder = query['SortOrder'] || 'Descending';

    const argsDict = { ...query, StartIndex: startIndex, Limit: limit, SortBy: sortBy, SortOrder: sortOrder };

    const sortMap: Record < string, string > = {
        "SortName": "title",
        "Name": "title",
        "DateCreated": "last_scanned_date",
        "PremiereDate": "premiered",
        "CommunityRating": "rating",
        "RunTimeTicks": "runtime",
        // "movieCount": "id" // 通常不在通用 items 列表排序，注释掉或移除
    };
    let dbSortBy = sortMap[sortBy] || "premiered";
    const validSortCols = ["title", "rating", "runtime", "premiered", "uniqueid_num", "last_scanned_date", "id"];
    if (!validSortCols.includes(dbSortBy)) dbSortBy = "premiered";
    const dbSortOrder = sortOrder.toUpperCase() === "DESCENDING" ? "DESC" : "ASC";

    const { clause, params: whereParams } = buildMovieWhereClauseAndParams(argsDict);

    const countQuery = c.env.DB_MOVIES.prepare(`SELECT COUNT(id) as total FROM movies WHERE ${clause}`);
    const dataQuery = c.env.DB_MOVIES.prepare(`SELECT * FROM movies WHERE ${clause} ORDER BY ${dbSortBy} ${dbSortOrder} NULLS LAST LIMIT ? OFFSET ?`);

    try {
        const totalResult = await countQuery.bind(...whereParams).first < { total: number } > ();
        const totalCount = totalResult?.total || 0;

        const itemsRaw = await dataQuery.bind(...whereParams, limit, startIndex).all();

        const itemsListPromises = (itemsRaw.results || []).map(row => movieRowToDict(c, row, c.env.DB_MOVIES));
        const itemsList = (await Promise.all(itemsListPromises)).filter(item => item !== null) as Movie[]; // Cast to Movie[]

        return c.json({
            Items: itemsList,
            TotalRecordCount: totalCount,
            CurrentPage: (startIndex / limit) + 1,
            PageSize: limit,
            TotalPages: Math.ceil(totalCount / limit) || 1, // Avoid 0 total pages if count is 0
        });
    } catch (dbError: any) {
        console.error("Database error in /api_movies/items:", dbError.message, dbError.cause);
        return c.json({ error: "Database query failed", details: dbError.message, cause: dbError.cause?.message || dbError.cause }, 500);
    }
});

// GET /api_movies/items/:item_id_or_num
movieApiApp.get('/items/:item_id_or_num{.+}', async (c) => {
    const itemIdOrNum = c.req.param('item_id_or_num');
    let movieRaw: any;

    if (!isNaN(parseInt(itemIdOrNum, 10))) {
        movieRaw = await c.env.DB_MOVIES.prepare("SELECT * FROM movies WHERE id = ?").bind(parseInt(itemIdOrNum, 10)).first();
    } else {
        movieRaw = await c.env.DB_MOVIES.prepare("SELECT * FROM movies WHERE uniqueid_num = ?").bind(itemIdOrNum).first();
    }

    if (!movieRaw) {
        return c.json({ error: "Movie not found" }, 404);
    }
    const movieDict = await movieRowToDict(c, movieRaw, c.env.DB_MOVIES);
    return c.json(movieDict);
});


// POST /api_movies/items/:item_id_or_num/like
movieApiApp.post('/items/:item_id_or_num/like', async (c) => { // Path changed to explicitly include /like
    const itemIdOrNum = c.req.param('item_id_or_num');
    const clientIp = getClientIp(c);
    let movieId: number | null = null;
    let movieTitle: string | null = null;

    let row: { id: number, title: string | null } | null = null; // title can be null
    if (!isNaN(parseInt(itemIdOrNum, 10))) {
        row = await c.env.DB_MOVIES.prepare("SELECT id, title FROM movies WHERE id = ?").bind(parseInt(itemIdOrNum, 10)).first();
    } else {
        row = await c.env.DB_MOVIES.prepare("SELECT id, title FROM movies WHERE uniqueid_num = ?").bind(itemIdOrNum).first();
    }

    if (row) {
        movieId = row.id;
        movieTitle = row.title;
    }

    if (!movieId) {
        return c.json({ error: "Movie not found" }, 404);
    }

    try {
        // Assuming 'movies' table has an 'is_liked' column (INTEGER DEFAULT 0)
        await c.env.DB_MOVIES.prepare("UPDATE movies SET is_liked = 1 WHERE id = ?").bind(movieId).run();
        console.info(`${clientIp} - Liked movie: '${movieTitle || 'N/A'}' (ID/Num: ${itemIdOrNum})`);
        return c.json({ message: "Movie liked", is_liked: true });
    } catch (e: any) {
        console.error(`Error liking movie ${movieId}: ${e.message}`);
        return c.json({ error: "Failed to like movie", details: e.message }, 500);
    }
});

// DELETE /api_movies/items/:item_id_or_num/like
movieApiApp.delete('/items/:item_id_or_num/like', async (c) => { // Path changed to explicitly include /like
    const itemIdOrNum = c.req.param('item_id_or_num');
    const clientIp = getClientIp(c);
    let movieId: number | null = null;
    let movieTitle: string | null = null;

    let row: { id: number, title: string | null } | null = null;
    if (!isNaN(parseInt(itemIdOrNum, 10))) {
        row = await c.env.DB_MOVIES.prepare("SELECT id, title FROM movies WHERE id = ?").bind(parseInt(itemIdOrNum, 10)).first();
    } else {
        row = await c.env.DB_MOVIES.prepare("SELECT id, title FROM movies WHERE uniqueid_num = ?").bind(itemIdOrNum).first();
    }

    if (row) {
        movieId = row.id;
        movieTitle = row.title;
    }

    if (!movieId) {
        return c.json({ error: "Movie not found" }, 404);
    }
    try {
        // Assuming 'movies' table has an 'is_liked' column
        await c.env.DB_MOVIES.prepare("UPDATE movies SET is_liked = 0 WHERE id = ?").bind(movieId).run();
        console.info(`${clientIp} - Unliked movie: '${movieTitle || 'N/A'}' (ID/Num: ${itemIdOrNum})`);
        return c.json({ message: "Movie unliked", is_liked: false });
    } catch (e: any) {
        console.error(`Error unliking movie ${movieId}: ${e.message}`);
        return c.json({ error: "Failed to unlike movie", details: e.message }, 500);
    }
});


// GET /api_movies/images/poster/:movie_id_or_num
movieApiApp.get('/images/poster/:movie_id_or_num{.+}', async (c) => {
    const movieIdOrNum = c.req.param('movie_id_or_num');
    // Assuming poster_file_relative_path is the column name based on your initial DDL
    let dbRow: { poster_file_relative_path: string } | null = null;

    if (!isNaN(parseInt(movieIdOrNum, 10))) {
        dbRow = await c.env.DB_MOVIES.prepare("SELECT poster_file_relative_path FROM movies WHERE id = ?").bind(parseInt(movieIdOrNum, 10)).first();
    } else {
        dbRow = await c.env.DB_MOVIES.prepare("SELECT poster_file_relative_path FROM movies WHERE uniqueid_num = ?").bind(movieIdOrNum).first();
    }

    if (dbRow && dbRow.poster_file_relative_path) {
        const r2Key = `${c.env.MOVIE_ASSETS_R2_BASE_PREFIX}/${dbRow.poster_file_relative_path}`.replace(/\/\//g, '/');
        return serveFileFromR2(c, c.env.MOVIES_BUCKET, r2Key);
    }
    // Fallback to serving a placeholder or a default image from R2 if needed
    // For now, just 404
    return c.text("Poster not found", 404);
});

// GET /api_movies/images/fanart/:movie_id_or_num
movieApiApp.get('/images/fanart/:movie_id_or_num{.+}', async (c) => {
    const movieIdOrNum = c.req.param('movie_id_or_num');
    // Assuming fanart_file_relative_path is the column name
    let dbRow: { fanart_file_relative_path: string } | null = null;
    if (!isNaN(parseInt(movieIdOrNum, 10))) {
        dbRow = await c.env.DB_MOVIES.prepare("SELECT fanart_file_relative_path FROM movies WHERE id = ?").bind(parseInt(movieIdOrNum, 10)).first();
    } else {
        dbRow = await c.env.DB_MOVIES.prepare("SELECT fanart_file_relative_path FROM movies WHERE uniqueid_num = ?").bind(movieIdOrNum).first();
    }

    if (dbRow && dbRow.fanart_file_relative_path) {
        const r2Key = `${c.env.MOVIE_ASSETS_R2_BASE_PREFIX}/${dbRow.fanart_file_relative_path}`.replace(/\/\//g, '/');
        return serveFileFromR2(c, c.env.MOVIES_BUCKET, r2Key);
    }
    return c.text("Fanart not found", 404);
});

// GET /api_movies/images/actor_thumb/:actor_name
movieApiApp.get('/images/actor_thumb/:actor_name{.+}', async (c) => {
    const actorName = decodeURIComponent(c.req.param('actor_name')); // Actor names might have spaces
    // Assuming an 'actors_info' table with 'name' and 'thumb_path'
    // and thumb_path is relative to ACTOR_THUMBS_R2_SUBFOLDER
    const dbRow: { thumb_path: string } | null = await c.env.DB_MOVIES.prepare(
        "SELECT thumb_path FROM actors_info WHERE name = ?" // Assuming actors_info is in DB_MOVIES
    )
    .bind(actorName)
    .first();

    if (dbRow && dbRow.thumb_path) {
        const r2Key = `${c.env.MOVIE_ASSETS_R2_BASE_PREFIX}/${c.env.ACTOR_THUMBS_R2_SUBFOLDER}/${dbRow.thumb_path}`.replace(/\/\//g, '/');
        return serveFileFromR2(c, c.env.MOVIES_BUCKET, r2Key);
    }
    return c.text("Actor thumb not found", 404);
});

// GET /api_movies/stream/:item_id_or_num
movieApiApp.get('/stream/:item_id_or_num{.+}', async (c) => {
    const itemIdOrNum = c.req.param('item_id_or_num');
    const clientIp = getClientIp(c);
    // Assuming 'strm_files' column stores JSON array of relative paths or full R2 keys
    let movieRaw: { id: number, title: string | null, strm_files: string | null } | null = null;

    if (!isNaN(parseInt(itemIdOrNum, 10))) {
        movieRaw = await c.env.DB_MOVIES.prepare("SELECT id, title, strm_files FROM movies WHERE id = ?").bind(parseInt(itemIdOrNum, 10)).first();
    } else {
        movieRaw = await c.env.DB_MOVIES.prepare("SELECT id, title, strm_files FROM movies WHERE uniqueid_num = ?").bind(itemIdOrNum).first();
    }

    if (!movieRaw) {
        return c.json({ error: "Movie not found for streaming" }, 404);
    }
    console.info(`${clientIp} - Stream request for movie: '${movieRaw.title || 'N/A'}' (ID/Num: ${itemIdOrNum})`);

    if (!movieRaw.strm_files) {
        return c.json({ error: "Stream files metadata not found for this movie" }, 404);
    }
    const strmFilesList = parseJsonField < string | { url: string } > (movieRaw.strm_files); // Can be string or object

    if (!strmFilesList || strmFilesList.length === 0) {
        return c.json({ error: "No stream links available" }, 404);
    }

    let streamPathOrKey: string | undefined;
    const firstStreamEntry = strmFilesList[0];

    if (typeof firstStreamEntry === 'string') {
        streamPathOrKey = firstStreamEntry;
    } else if (typeof firstStreamEntry === 'object' && firstStreamEntry !== null && firstStreamEntry.url) {
        streamPathOrKey = firstStreamEntry.url;
    }

    if (!streamPathOrKey) {
        return c.json({ error: "Valid R2 key/path for video file not found in strm_files" }, 404);
    }

    // Determine if streamPathOrKey is an absolute R2 key or relative path
    // For now, assume it's a path relative to MOVIE_ASSETS_R2_BASE_PREFIX
    const fullR2Key = `${c.env.MOVIE_ASSETS_R2_BASE_PREFIX}/${streamPathOrKey}`.replace(/\/\//g, '/');

    console.info(`${clientIp} - Started playing movie: '${movieRaw.title || 'N/A'}' (ID/Num: ${itemIdOrNum}) from R2 key: ${fullR2Key}`);
    if (!c.env.MOVIES_BUCKET) {
        console.error("[R2] MOVIES_BUCKET for streams is not bound.");
        return c.text("Stream service misconfiguration", 500);
    }
    return serveFileFromR2(c, c.env.MOVIES_BUCKET, fullR2Key, 'public, max-age=86400'); // Longer cache for video
});


// GET /api_movies/genres
movieApiApp.get('/genres', async (c) => {
    const parentId = c.req.query('ParentId'); // This is scan_root
    let query = "SELECT DISTINCT genres FROM movies WHERE genres IS NOT NULL AND genres != '' AND genres != '[]'";
    const params: string[] = [];
    if (parentId) {
        query += " AND scan_root = ?"; // Use scan_root
        params.push(parentId);
    }
    const { results } = await c.env.DB_MOVIES.prepare(query).bind(...params).all < { genres: string } > ();
    const allGenreNames = new Set < string > ();
    (results || []).forEach(row => {
        parseJsonField < string > (row.genres).forEach(gName => {
            if (gName?.trim()) allGenreNames.add(gName.trim());
        });
    });
    return c.json(Array.from(allGenreNames).sort().map(g => ({ Name: g, Id: g }))); // Frontend expects Id and Name
});

// GET /api_movies/libraries
movieApiApp.get('/libraries', async (c) => {
    const { results } = await c.env.DB_MOVIES.prepare(
        "SELECT DISTINCT scan_root FROM movies WHERE scan_root IS NOT NULL AND scan_root != ''" // Use scan_root
    ).all < { scan_root: string } > ();

    const libs = (results || []).map(row => {
        const fullPath = row.scan_root;
        // Attempt to get a more friendly name, e.g., the last part of the path
        const nameParts = fullPath.split(/[/\\]/);
        const name = nameParts.pop() || fullPath; // Use last part, or full path if empty
        return { Name: name, Id: fullPath }; // Frontend expects Id and Name
    }).sort((a, b) => a.Name.localeCompare(b.Name));
    return c.json(libs);
});

// GET /api_movies/persons (Actors, Directors)
movieApiApp.get('/persons', async (c) => {
    const personType = c.req.query('PersonType')?.toLowerCase() || 'actor';
    const parentId = c.req.query('ParentId'); // This is scan_root

    const personsMap: Record < string, { Name: string, Id: string, MovieCount: number, Type: string, ImageTag?: string } > = {};

    let movieQuery = "SELECT id, actors, director, scan_root FROM movies"; // Use scan_root
    const conditions: string[] = [];
    const params: string[] = [];

    if (personType === 'actor') {
        conditions.push("actors IS NOT NULL AND actors != '' AND actors != '[]'");
    } else if (personType === 'director') {
        conditions.push("director IS NOT NULL AND director != '' AND director != '[]'");
    } else {
        return c.json({ error: "Invalid PersonType" }, 400);
    }

    if (parentId) {
        conditions.push("scan_root = ?"); // Use scan_root
        params.push(parentId);
    }
    if (conditions.length > 0) {
        movieQuery += " WHERE " + conditions.join(" AND ");
    }

    const movieRowsResult = await c.env.DB_MOVIES.prepare(movieQuery).bind(...params).all < Movie > ();
    const movieRows = movieRowsResult.results || [];

    const actorThumbs: Record < string, string > = {};
    if (personType === 'actor') {
        const thumbRowsResult = await c.env.DB_MOVIES.prepare(
            "SELECT name, thumb_path FROM actors_info WHERE thumb_path IS NOT NULL AND thumb_path != ''"
        ).all < ActorInfoDb > (); // Assuming actors_info table
        (thumbRowsResult.results || []).forEach(tr => {
            if (tr.name && tr.thumb_path) actorThumbs[tr.name] = tr.thumb_path;
        });
    }

    movieRows.forEach(movie => {
        if (personType === 'actor') {
            const movieActors = parseJsonField < { name: string, role?: string, thumb?: string } > (movie.actors);
            movieActors.forEach(actorData => {
                const name = actorData.name;
                if (name) {
                    if (!personsMap[name]) {
                        let imageTag: string | undefined = undefined;
                        // Use thumb from movie.actors JSON first if available, then from actors_info
                        let thumbSourcePath = actorData.thumb || actorThumbs[name];
                        if (thumbSourcePath) {
                            // Construct full URL. Assumes thumbSourcePath is just filename for actors_info,
                            // or could be a relative path within MOVIE_ASSETS_R2_BASE_PREFIX/ACTOR_THUMBS_R2_SUBFOLDER
                            // This might need refinement based on how actorData.thumb is stored.
                            // For now, assume it's a filename for simplicity if from actorData.thumb
                            imageTag = `${c.req.url.origin}/api_movies/images/actor_thumb/${encodeURIComponent(name)}`;
                        }
                        personsMap[name] = { Name: name, Id: name, MovieCount: 0, Type: 'Actor', ImageTag: imageTag };
                    }
                    personsMap[name].MovieCount++;
                }
            });
        } else if (personType === 'director' && movie.director) {
            // Assuming director field can be a JSON array of strings or a single string
            const directors = parseJsonField < string > (movie.director);
            directors.forEach(name => {
                if (name) {
                    if (!personsMap[name]) {
                        personsMap[name] = { Name: name, Id: name, MovieCount: 0, Type: 'Director' };
                    }
                    personsMap[name].MovieCount++;
                }
            });
        }
    });
    const sortedPersons = Object.values(personsMap).sort((a, b) => (b.MovieCount || 0) - (a.MovieCount || 0) || a.Name.localeCompare(b.Name));
    return c.json(sortedPersons);
});

// GET /api_movies/studios
movieApiApp.get('/studios', async (c) => {
    const parentId = c.req.query('ParentId'); // This is scan_root
    const studiosMap: Record < string, { Name: string, Id: string, MovieCount: number } > = {};
    let query = "SELECT studio FROM movies WHERE studio IS NOT NULL AND studio != ''";
    const params: string[] = [];

    if (parentId) {
        query += " AND scan_root = ?"; // Use scan_root
        params.push(parentId);
    }

    const { results } = await c.env.DB_MOVIES.prepare(query).bind(...params).all < { studio: string } > ();
    (results || []).forEach(row => {
        const name = row.studio.trim();
        if (name) { // Ensure name is not empty after trim
            if (!studiosMap[name]) studiosMap[name] = { Name: name, Id: name, MovieCount: 0 };
            studiosMap[name].MovieCount++;
        }
    });
    const sortedStudios = Object.values(studiosMap).sort((a, b) => (b.MovieCount || 0) - (a.MovieCount || 0) || a.Name.localeCompare(b.Name));
    return c.json(sortedStudios);
});

// GET /api_movies/series
movieApiApp.get('/series', async (c) => {
    const parentId = c.req.query('ParentId'); // This is scan_root
    const seriesMap: Record < string, {
        Id: string, Name: string, ChildCount: number, Genres: Set < string > ,
        PrimaryImageTag: string | null, // URL to poster of one movie in series
        BackdropImageTags: string[] // URLs to fanart of some movies in series
    } > = {};

    let query = "SELECT id, set_name, genres, premiered, poster_file_relative_path, fanart_file_relative_path, scan_root FROM movies WHERE set_name IS NOT NULL AND set_name != ''";
    const params: string[] = [];
    if (parentId) {
        query += " AND scan_root = ?"; // Use scan_root
        params.push(parentId);
    }
    query += " ORDER BY set_name ASC, premiered ASC"; // Sort to pick earliest movie's poster/fanart

    const movieRowsResult = await c.env.DB_MOVIES.prepare(query).bind(...params).all < Movie > ();
    const movieRows = movieRowsResult.results || [];

    movieRows.forEach(movie => {
        const name = movie.set_name !;
        if (!seriesMap[name]) {
            seriesMap[name] = {
                Id: name, // Series ID is its name
                Name: name,
                ChildCount: 0,
                Genres: new Set < string > (),
                PrimaryImageTag: null,
                BackdropImageTags: []
            };
        }
        seriesMap[name].ChildCount++;
        const movieGenres = parseJsonField < string > (movie.genres);
        movieGenres.forEach(g => { if (g) seriesMap[name].Genres.add(g); });

        // Use poster/fanart from the (arbitrarily, due to sort) first movie encountered for the series
        if (!seriesMap[name].PrimaryImageTag && movie.poster_file_relative_path && movie.id) {
            seriesMap[name].PrimaryImageTag = `${c.req.url.origin}/api_movies/images/poster/${movie.id}`;
        }
        if (movie.fanart_file_relative_path && seriesMap[name].BackdropImageTags.length < 1 && movie.id) { // Get one backdrop
            seriesMap[name].BackdropImageTags.push(`${c.req.url.origin}/api_movies/images/fanart/${movie.id}`);
        }
    });

    const resultList = Object.values(seriesMap).map(data => {
        return {
            ...data,
            Genres: Array.from(data.Genres).sort() // Convert Set to Array for JSON
        };
    }).sort((a, b) => a.Name.localeCompare(b.Name));

    return c.json(resultList);
});

// GET /api_movies/items/:item_id_or_num/precomputed_related
movieApiApp.get('/items/:item_id_or_num/precomputed_related', async (c) => {
    const itemIdOrNum = c.req.param('item_id_or_num');
    let sourceMovieId: number | null = null;
    const MAX_PRIMARY_RELATED = c.env.MAX_PRIMARY_RELATED_COUNT ? parseInt(c.env.MAX_PRIMARY_RELATED_COUNT) : 8; // Example from env
    const NUM_RANDOM_GENRE_PICKS = c.env.NUM_RANDOM_GENRE_PICKS ? parseInt(c.env.NUM_RANDOM_GENRE_PICKS) : 2;
    const MAX_GENRE_CANDIDATES = c.env.MAX_GENRE_CANDIDATES ? parseInt(c.env.MAX_GENRE_CANDIDATES) : 10;

    let sourceMovieRow: { id: number } | null = null;
    if (!isNaN(parseInt(itemIdOrNum, 10))) {
        sourceMovieRow = await c.env.DB_MOVIES.prepare("SELECT id FROM movies WHERE id = ?").bind(parseInt(itemIdOrNum, 10)).first();
    } else {
        sourceMovieRow = await c.env.DB_MOVIES.prepare("SELECT id FROM movies WHERE uniqueid_num = ?").bind(itemIdOrNum).first();
    }
    if (sourceMovieRow) sourceMovieId = sourceMovieRow.id;

    if (!sourceMovieId) {
        return c.json({ error: "Source movie not found" }, 404);
    }
    // Assuming 'precomputed_related_movies' table exists in DB_MOVIES
    const primaryRelatedResult = await c.env.DB_MOVIES.prepare(`
        SELECT m.*
        FROM precomputed_related_movies prm
        JOIN movies m ON prm.related_movie_id = m.id
        WHERE prm.source_movie_id = ? AND prm.relation_type != 'genre_random_pick'
        ORDER BY prm.relevance_score DESC, m.rating DESC
        LIMIT ?
    `).bind(sourceMovieId, MAX_PRIMARY_RELATED).all < Movie > ();

    const primaryRelatedPromises = (primaryRelatedResult.results || []).map(row => movieRowToDict(c, row, c.env.DB_MOVIES));
    const primaryRelatedList = (await Promise.all(primaryRelatedPromises)).filter(Boolean) as Movie[];

    const relatedIdsSoFar = new Set(primaryRelatedList.map(m => m.Id));
    let genreRandomRelatedList: Movie[] = [];

    if (NUM_RANDOM_GENRE_PICKS > 0) {
        const genreCandidatesResult = await c.env.DB_MOVIES.prepare(`
            SELECT m.*
            FROM precomputed_related_movies prm
            JOIN movies m ON prm.related_movie_id = m.id
            WHERE prm.source_movie_id = ? AND prm.relation_type = 'genre_random_pick'
            ORDER BY RANDOM()
            LIMIT ?
        `).bind(sourceMovieId, MAX_GENRE_CANDIDATES).all < Movie > ();

        const genreCandidatePromises = (genreCandidatesResult.results || []).map(row => movieRowToDict(c, row, c.env.DB_MOVIES));
        const genreCandidatesList = (await Promise.all(genreCandidatePromises)).filter(Boolean) as Movie[];

        for (const movieDict of genreCandidatesList) {
            if (genreRandomRelatedList.length >= NUM_RANDOM_GENRE_PICKS) break;
            if (movieDict.Id && !relatedIdsSoFar.has(movieDict.Id)) { // Ensure Id is present
                genreRandomRelatedList.push(movieDict);
                relatedIdsSoFar.add(movieDict.Id);
            }
        }
    }
    return c.json([...primaryRelatedList, ...genreRandomRelatedList]);
});

/*
// --- MOVIE COLLECTIONS APIs - COMMENTED OUT as movie_collections table is removed ---

// GET /api_movies/movie_collections
movieApiApp.get('/movie_collections', async (c) => {
    // This API depends on a 'movie_collections' table which is now removed.
    // If this functionality is still needed, it requires a new design.
    console.warn("/api_movies/movie_collections GET endpoint called, but 'movie_collections' table is removed.");
    return c.json({ error: "This feature (movie_collections) is currently unavailable or has been redesigned." }, 501);

    // Original code (would fail):
    // const { results } = await c.env.DB_MOVIES.prepare(
    //     "SELECT id, name FROM movie_collections ORDER BY name ASC"
    // ).all<{id: number, name: string }>();
    // return c.json(results || []);
});

// POST /api_movies/movie_collections
movieApiApp.post('/movie_collections', async (c) => {
    // This API depends on a 'movie_collections' table which is now removed.
    console.warn("/api_movies/movie_collections POST endpoint called, but 'movie_collections' table is removed.");
    return c.json({ error: "This feature (movie_collections) is currently unavailable or has been redesigned." }, 501);

    // Original code (would fail):
    // const clientIp = getClientIp(c);
    // const payload = await c.req.json<{name: string}>();
    // const collectionName = payload.name?.trim();

    // if (!collectionName) {
    //     return c.json({ error: "Name required" }, 400);
    // }
    // try {
    //     const result = await c.env.DB_MOVIES.prepare("INSERT INTO movie_collections (name) VALUES (?) RETURNING id")
    //         .bind(collectionName)
    //         .first<{id: number}>();
    //     if (result && result.id) {
    //         console.info(`${clientIp} - Created movie collection: '${collectionName}' (ID: ${result.id})`);
    //         return c.json({ id: result.id, name: collectionName }, 201);
    //     } else {
    //         throw new Error("Failed to get ID of new collection.");
    //     }
    // } catch (e: any) {
    //     if (e.message?.includes("UNIQUE constraint failed")) {
    //         return c.json({ error: "Collection name already exists" }, 409);
    //     }
    //     console.error(`Error creating movie collection: ${e.message}`);
    //     return c.json({ error: "Database error", details: e.message }, 500);
    // }
});
*/

export default movieApiApp; // Make sure this is how you export if using it in a larger Hono app
