import { Hono } from 'hono';
import { Env, Movie, ActorInfoDb } from './types'; // Removed unused Comment, CollectionInfo for now
import { getClientIp } from './auth';
import { movieRowToDict, buildMovieWhereClauseAndParams, parseJsonField } from './dbUtils';
import { serveFileFromR2 } from './r2Utils';

export const movieApiApp = new Hono<{ Bindings: Env }>();

// GET /api_movies/items
movieApiApp.get('/items', async (c) => {
  const query = c.req.query();
  const startIndex = parseInt(query['StartIndex'] || '0', 10);
  const limit = parseInt(query['Limit'] || '100', 10);
  const sortBy = query['SortBy'] || 'PremiereDate';
  const sortOrder = query['SortOrder'] || 'Descending';

  const argsDict = { ...query, StartIndex: startIndex, Limit: limit, SortBy: sortBy, SortOrder: sortOrder };

  const sortMap: Record<string, string> = {
      "SortName": "title", "Name": "title",
      "DateCreated": "last_scanned_date", "PremiereDate": "premiered",
      "CommunityRating": "rating", "RunTimeTicks": "runtime",
      "movieCount": "id" 
  };
  let dbSortBy = sortMap[sortBy] || "premiered";
  const validSortCols = ["title", "rating", "runtime", "premiered", "uniqueid_num", "last_scanned_date", "id"];
  if (!validSortCols.includes(dbSortBy)) dbSortBy = "premiered";
  const dbSortOrder = sortOrder.toUpperCase() === "DESCENDING" ? "DESC" : "ASC";

  const { clause, params: whereParams } = buildMovieWhereClauseAndParams(argsDict);

  const countQuery = c.env.DB_MOVIES.prepare(`SELECT COUNT(id) as total FROM movies WHERE ${clause}`);
  const dataQuery = c.env.DB_MOVIES.prepare(`SELECT * FROM movies WHERE ${clause} ORDER BY ${dbSortBy} ${dbSortOrder} NULLS LAST LIMIT ? OFFSET ?`);

  try {
    const totalResult = await countQuery.bind(...whereParams).first<{ total: number }>();
    const totalCount = totalResult?.total || 0;

    const itemsRaw = await dataQuery.bind(...whereParams, limit, startIndex).all();
    
    const itemsListPromises = (itemsRaw.results || []).map(row => movieRowToDict(c, row, c.env.DB_MOVIES));
    const itemsList = (await Promise.all(itemsListPromises)).filter(item => item !== null);

    return c.json({
      Items: itemsList,
      TotalRecordCount: totalCount,
      CurrentPage: (startIndex / limit) + 1,
      PageSize: limit,
      TotalPages: Math.ceil(totalCount / limit) || 0,
    });
  } catch (dbError: any) {
    console.error("Database error in /api_movies/items:", dbError);
    return c.json({ error: "Database query failed", details: dbError.message, cause: dbError.cause?.message }, 500);
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
movieApiApp.post('/items/:item_id_or_num{.+}', async (c) => {
    const itemIdOrNum = c.req.param('item_id_or_num');
    const clientIp = getClientIp(c);
    let movieId: number | null = null;
    let movieTitle: string | null = null;

    let row: { id: number, title: string } | null = null;
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
        await c.env.DB_MOVIES.prepare("UPDATE movies SET is_liked = 1 WHERE id = ?").bind(movieId).run();
        console.info(`${clientIp} - Liked movie: '${movieTitle}' (ID/Num: ${itemIdOrNum})`); 
        return c.json({ message: "Movie liked", is_liked: true });
    } catch (e: any) {
        console.error(`Error liking movie ${movieId}: ${e.message}`);
        return c.json({ error: "Failed to like movie", details: e.message }, 500);
    }
});

// DELETE /api_movies/items/:item_id_or_num/like
movieApiApp.delete('/items/:item_id_or_num{.+}', async (c) => {
    const itemIdOrNum = c.req.param('item_id_or_num');
    const clientIp = getClientIp(c);
    let movieId: number | null = null;
    let movieTitle: string | null = null;
    
    let row: { id: number, title: string } | null = null;
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
        await c.env.DB_MOVIES.prepare("UPDATE movies SET is_liked = 0 WHERE id = ?").bind(movieId).run();
        console.info(`${clientIp} - Unliked movie: '${movieTitle}' (ID/Num: ${itemIdOrNum})`);
        return c.json({ message: "Movie unliked", is_liked: false });
    } catch (e: any) {
        console.error(`Error unliking movie ${movieId}: ${e.message}`);
        return c.json({ error: "Failed to unlike movie", details: e.message }, 500);
    }
});


// --- MODIFIED START: POSTER IMAGE LOGIC ---
// GET /api_movies/images/poster/:movie_id_or_num
movieApiApp.get('/images/poster/:movie_id_or_num{.+}', async (c) => {
  const movieIdOrNum = c.req.param('movie_id_or_num');
  
  // 1. 定义 dbRow 类型，包含两个路径字段
  let dbRow: { folder_path_relative: string, poster_file_relative_path: string } | null = null;
  
  // 2. 修改 SQL 查询，获取两个路径字段
  const query = "SELECT folder_path_relative, poster_file_relative_path FROM movies WHERE";

  if (!isNaN(parseInt(movieIdOrNum, 10))) {
    dbRow = await c.env.DB_MOVIES.prepare(`${query} id = ?`).bind(parseInt(movieIdOrNum, 10)).first();
  } else {
    dbRow = await c.env.DB_MOVIES.prepare(`${query} uniqueid_num = ?`).bind(movieIdOrNum).first();
  }

  // 3. 检查新字段并拼接它们以构建 R2 Key
  if (dbRow && dbRow.folder_path_relative && dbRow.poster_file_relative_path) {
    const fullRelativePath = `${dbRow.folder_path_relative}/${dbRow.poster_file_relative_path}`;
    const r2Key = `${c.env.MOVIE_ASSETS_R2_BASE_PREFIX}/${fullRelativePath}`.replace(/\/\//g, '/');
    return serveFileFromR2(c, c.env.MOVIES_ASSETS_BUCKET, r2Key);
  }

  return c.text("Poster not found", 404);
});
// --- MODIFIED END: POSTER IMAGE LOGIC ---


// --- MODIFIED START: FANART IMAGE LOGIC ---
// GET /api_movies/images/fanart/:movie_id_or_num
movieApiApp.get('/images/fanart/:movie_id_or_num{.+}', async (c) => {
  const movieIdOrNum = c.req.param('movie_id_or_num');
  
  // 1. 定义 dbRow 类型，包含两个路径字段
  // 假设 fanart 的字段名为 fanart_file_relative_path，请根据您的数据库进行调整
  let dbRow: { folder_path_relative: string, fanart_file_relative_path: string } | null = null;
  
  // 2. 修改 SQL 查询，获取两个路径字段
  const query = "SELECT folder_path_relative, fanart_file_relative_path FROM movies WHERE";

  if (!isNaN(parseInt(movieIdOrNum, 10))) {
    dbRow = await c.env.DB_MOVIES.prepare(`${query} id = ?`).bind(parseInt(movieIdOrNum,10)).first();
  } else {
    dbRow = await c.env.DB_MOVIES.prepare(`${query} uniqueid_num = ?`).bind(movieIdOrNum).first();
  }

  // 3. 检查新字段并拼接它们以构建 R2 Key
  if (dbRow && dbRow.folder_path_relative && dbRow.fanart_file_relative_path) {
    const fullRelativePath = `${dbRow.folder_path_relative}/${dbRow.fanart_file_relative_path}`;
    const r2Key = `${c.env.MOVIE_ASSETS_R2_BASE_PREFIX}/${fullRelativePath}`.replace(/\/\//g, '/');
    return serveFileFromR2(c, c.env.MOVIES_ASSETS_BUCKET, r2Key);
  }

  return c.text("Fanart not found", 404);
});
// --- MODIFIED END: FANART IMAGE LOGIC ---


// GET /api_movies/images/actor_thumb/:actor_name
// 注意: 此部分未修改，因为它从 actors_info 表获取数据，可能使用不同的路径结构。
// 如果也需要修改，请参照上面的模式进行。
movieApiApp.get('/images/actor_thumb/:actor_name{.+}', async (c) => {
    const actorName = c.req.param('actor_name');
    const dbRow: { thumb_path: string } | null = await c.env.DB_MOVIES.prepare("SELECT thumb_path FROM actors_info WHERE name = ?")
        .bind(actorName)
        .first();

    if (dbRow && dbRow.thumb_path) {
        const r2Key = `${c.env.MOVIE_ASSETS_R2_BASE_PREFIX}/${c.env.ACTOR_THUMBS_R2_SUBFOLDER}/${dbRow.thumb_path}`.replace(/\/\//g, '/');
        return serveFileFromR2(c, c.env.MOVIES_ASSETS_BUCKET, r2Key);
    }
    return c.text("Actor thumb not found", 404);
});

// GET /api_movies/stream/:item_id_or_num
movieApiApp.get('/stream/:item_id_or_num{.+}', async (c) => {
    const itemIdOrNum = c.req.param('item_id_or_num');
    const clientIp = getClientIp(c);
    let movieRaw: { id: number, title: string, strm_files: string } | null = null;

    if (!isNaN(parseInt(itemIdOrNum, 10))) {
        movieRaw = await c.env.DB_MOVIES.prepare("SELECT id, title, strm_files FROM movies WHERE id = ?").bind(parseInt(itemIdOrNum, 10)).first();
    } else {
        movieRaw = await c.env.DB_MOVIES.prepare("SELECT id, title, strm_files FROM movies WHERE uniqueid_num = ?").bind(itemIdOrNum).first();
    }
    
    if (!movieRaw) {
        return c.json({ error: "Movie not found for streaming" }, 404);
    }
    console.info(`${clientIp} - Stream request for movie: '${movieRaw.title}' (ID/Num: ${itemIdOrNum})`);

    if (!movieRaw.strm_files) {
        return c.json({ error: "Stream files not found for this movie" }, 404);
    }
    const strmFilesList = parseJsonField<any>(movieRaw.strm_files);

    if (!strmFilesList || strmFilesList.length === 0) {
        return c.json({ error: "No stream links available" }, 404);
    }

    let streamR2Key: string | undefined;
    const firstStreamEntry = strmFilesList[0];

    if (typeof firstStreamEntry === 'string') {
        streamR2Key = firstStreamEntry;
    } else if (typeof firstStreamEntry === 'object' && firstStreamEntry !== null && firstStreamEntry.url) {
        streamR2Key = firstStreamEntry.url; 
    }

    if (!streamR2Key) {
         return c.json({ error: "Valid R2 key for video file not found in strm_files" }, 404);
    }
    
    const fullR2Key = `${c.env.MOVIE_ASSETS_R2_BASE_PREFIX}/${streamR2Key}`.replace(/\/\//g, '/');
    
    console.info(`${clientIp} - Started playing movie: '${movieRaw.title}' (ID/Num: ${itemIdOrNum}) from R2 key: ${fullR2Key}`);
    if (!c.env.MOVIES_ASSETS_BUCKET) {
        console.error("[R2] MOVIES_ASSETS_BUCKET for streams is not bound.");
        return c.text("Stream service misconfiguration", 500);
    }
    return serveFileFromR2(c, c.env.MOVIES_ASSETS_BUCKET, fullR2Key, 'public, max-age=3600'); 
});


// GET /api_movies/genres
movieApiApp.get('/genres', async (c) => {
    const parentId = c.req.query('ParentId');
    let query = "SELECT DISTINCT genres FROM movies";
    const params: string[] = [];
    if (parentId) {
    }
    const { results } = await c.env.DB_MOVIES.prepare(query).bind(...params).all<{genres: string}>();
    const allGenreNames = new Set<string>();
    (results || []).forEach(row => {
        parseJsonField<string>(row.genres).forEach(gName => {
            if (gName?.trim()) allGenreNames.add(gName.trim());
        });
    });
    return c.json(Array.from(allGenreNames).sort().map(g => ({ Name: g, Id: g })));
});

// GET /api_movies/libraries
movieApiApp.get('/libraries', async (c) => {
    const { results } = await c.env.DB_MOVIES.prepare(
        "SELECT DISTINCT root_folder FROM movies WHERE root_folder IS NOT NULL AND root_folder != ''"
    ).all<{root_folder: string}>();
    
    const libs = (results || []).map(row => {
        const fullPath = row.root_folder;
        const name = fullPath.split(/[/\\]/).pop() || fullPath;
        return { Name: name, Id: fullPath };
    }).sort((a,b) => a.Name.localeCompare(b.Name));
    return c.json(libs);
});

// GET /api_movies/persons
movieApiApp.get('/persons', async (c) => {
    const personType = c.req.query('PersonType') || 'Actor'; 
    const parentId = c.req.query('ParentId'); 

    const personsMap: Record<string, any> = {};

    let movieQuery = "SELECT id, actors, director, root_folder FROM movies";
    const conditions: string[] = [];
    const params: string[] = [];

    if (parentId) {

    }
    if (conditions.length > 0) {
        movieQuery += " WHERE " + conditions.join(" AND ");
    }
    const movieRowsResult = await c.env.DB_MOVIES.prepare(movieQuery).bind(...params).all<Movie>();
    const movieRows = movieRowsResult.results || [];

    const actorThumbs: Record<string, string> = {};
    if (personType.toLowerCase() === 'actor') {
        const thumbRowsResult = await c.env.DB_MOVIES.prepare(
            "SELECT name, thumb_path FROM actors_info WHERE thumb_path IS NOT NULL AND thumb_path != ''"
        ).all<ActorInfoDb>();
        (thumbRowsResult.results || []).forEach(tr => {
            if (tr.name && tr.thumb_path) actorThumbs[tr.name] = tr.thumb_path;
        });
    }
    
    movieRows.forEach(movie => {
        if (personType.toLowerCase() === 'actor') {
            const movieActors = parseJsonField<{name: string}>(movie.actors);
            movieActors.forEach(actorData => {
                const name = actorData.name;
                if (name) {
                    if (!personsMap[name]) {
                        let imageTag: string | undefined = undefined;
                        if (actorThumbs[name]) {
                            imageTag = `${c.req.url.origin}/api_movies/images/actor_thumb/${encodeURIComponent(name)}`;
                        }
                        personsMap[name] = { Name: name, Id: name, MovieCount: 0, Type: 'Actor', ImageTag: imageTag };
                    }
                    personsMap[name].MovieCount = (personsMap[name].MovieCount || 0) + 1;
                }
            });
        } else if (personType.toLowerCase() === 'director' && movie.director) {
            const directors = parseJsonField<string>(movie.director);
            directors.forEach(name => {
                 if (name) {
                    if (!personsMap[name]) {
                        personsMap[name] = { Name: name, Id: name, MovieCount: 0, Type: 'Director' };
                    }
                    personsMap[name].MovieCount = (personsMap[name].MovieCount || 0) + 1;
                }
            });
        }
    });
    const sortedPersons = Object.values(personsMap).sort((a, b) => (b.MovieCount || 0) - (a.MovieCount || 0));
    return c.json(sortedPersons);
});

// GET /api_movies/studios
movieApiApp.get('/studios', async (c) => {
    const parentId = c.req.query('ParentId');
    const studiosMap: Record<string, any> = {};
    let query = "SELECT studio FROM movies WHERE studio IS NOT NULL AND studio != ''";
    const params: string[] = [];

    if (parentId) {

    }
    const { results } = await c.env.DB_MOVIES.prepare(query).bind(...params).all<{studio: string}>();
    (results || []).forEach(row => {
        const name = row.studio;
        if (!studiosMap[name]) studiosMap[name] = { Name: name, Id: name, MovieCount: 0 };
        studiosMap[name].MovieCount = (studiosMap[name].MovieCount || 0) + 1;
    });
    const sortedStudios = Object.values(studiosMap).sort((a, b) => (b.MovieCount || 0) - (a.MovieCount || 0));
    return c.json(sortedStudios);
});

// GET /api_movies/series
movieApiApp.get('/series', async (c) => {
    const parentId = c.req.query('ParentId');
    const seriesMap: Record<string, any> = {};

    let query = "SELECT id, set_name, genres, premiered, root_folder FROM movies WHERE set_name IS NOT NULL AND set_name != ''";
    const params: string[] = [];
    if (parentId) {

    }
    query += " ORDER BY premiered DESC";
    // NOTE: The original code had poster_file_path and fanart_file_path here. 
    // Since these are no longer single fields, I've removed them from this SELECT.
    // The image URLs are constructed with the movie ID, which is correct and does not need to change.
    const movieRowsResult = await c.env.DB_MOVIES.prepare(query).bind(...params).all<Movie>();
    const movieRows = movieRowsResult.results || [];

    movieRows.forEach(movie => {
        const name = movie.set_name!; 
        if (!seriesMap[name]) {
            seriesMap[name] = {
                Id: name, Name: name, ChildCount: 0, Genres: new Set<string>(),
                PrimaryImageTag: null,
                BackdropImageTags: []
            };
        }
        seriesMap[name].ChildCount++;
        const movieGenres = parseJsonField<string>(movie.genres);
        movieGenres.forEach(g => seriesMap[name].Genres.add(g));

        // This logic remains correct. It builds a URL pointing to our API endpoint.
        // The API endpoint itself now knows how to resolve this ID into the correct file path.
        if (!seriesMap[name].PrimaryImageTag && movie.id) {
            seriesMap[name].PrimaryImageTag = `${c.req.url.origin}/api_movies/images/poster/${movie.id}`;
        }
        if (seriesMap[name].BackdropImageTags.length < 3 && movie.id) {
            seriesMap[name].BackdropImageTags.push(`${c.req.url.origin}/api_movies/images/fanart/${movie.id}`);
        }
    });

    const resultList = Object.values(seriesMap).map(data => {
        data.Genres = Array.from(data.Genres).sort();
        return data;
    }).sort((a,b) => a.Name.localeCompare(b.Name));

    return c.json(resultList);
});

// GET /api_movies/items/:item_id_or_num/precomputed_related
movieApiApp.get('/items/:item_id_or_num/precomputed_related', async (c) => {
    const itemIdOrNum = c.req.param('item_id_or_num');
    let sourceMovieId: number | null = null;
    const MAX_PRIMARY_RELATED = 8;
    const NUM_RANDOM_GENRE_PICKS = 2;
    const MAX_GENRE_CANDIDATES = 10;

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
    const primaryRelatedResult = await c.env.DB_MOVIES.prepare(`
        SELECT m.*
        FROM precomputed_related_movies prm
        JOIN movies m ON prm.related_movie_id = m.id
        WHERE prm.source_movie_id = ? AND prm.relation_type != 'genre_random_pick'
        ORDER BY prm.relevance_score DESC, m.rating DESC
        LIMIT ?
    `).bind(sourceMovieId, MAX_PRIMARY_RELATED).all<Movie>();
    
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
        `).bind(sourceMovieId, MAX_GENRE_CANDIDATES).all<Movie>();
        
        const genreCandidatePromises = (genreCandidatesResult.results || []).map(row => movieRowToDict(c, row, c.env.DB_MOVIES));
        const genreCandidatesList = (await Promise.all(genreCandidatePromises)).filter(Boolean) as Movie[];

        for (const movieDict of genreCandidatesList) {
            if (genreRandomRelatedList.length >= NUM_RANDOM_GENRE_PICKS) break;
            if (movieDict.Id && !relatedIdsSoFar.has(movieDict.Id)) {
                genreRandomRelatedList.push(movieDict);
                relatedIdsSoFar.add(movieDict.Id);
            }
        }
    }
    return c.json([...primaryRelatedList, ...genreRandomRelatedList]);
});

// GET /api_movies/movie_collections
movieApiApp.get('/movie_collections', async (c) => {
    const { results } = await c.env.DB_MOVIES.prepare(
        "SELECT id, name FROM movie_collections ORDER BY name ASC"
    ).all<{id: number, name: string }>(); 
    return c.json(results || []);
});

// POST /api_movies/movie_collections
movieApiApp.post('/movie_collections', async (c) => {
    const clientIp = getClientIp(c);
    const payload = await c.req.json<{name: string}>();
    const collectionName = payload.name?.trim();

    if (!collectionName) {
        return c.json({ error: "Name required" }, 400);
    }
    try {
        const result = await c.env.DB_MOVIES.prepare("INSERT INTO movie_collections (name) VALUES (?) RETURNING id")
            .bind(collectionName)
            .first<{id: number}>(); 
        if (result && result.id) {
            console.info(`${clientIp} - Created movie collection: '${collectionName}' (ID: ${result.id})`);
            return c.json({ id: result.id, name: collectionName }, 201);
        } else {
            throw new Error("Failed to get ID of new collection.");
        }
    } catch (e: any) {
        if (e.message?.includes("UNIQUE constraint failed")) { 
            return c.json({ error: "Collection name already exists" }, 409);
        }
        console.error(`Error creating movie collection: ${e.message}`);
        return c.json({ error: "Database error", details: e.message }, 500);
    }
});
