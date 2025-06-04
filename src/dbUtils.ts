import { Context } from 'hono';
import { Movie, PersonInfo, CollectionInfo, Env } from './types'; // Assuming Movie type is defined

// Helper to parse JSON fields that might be strings or already arrays
export function parseJsonField<T>(value: any, defaultValue: T[] = []): T[] {
  if (typeof value === 'string' && value) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [parsed]; // Ensure it's an array
    } catch (e) {
      // If JSON parsing fails, try splitting by comma (original behavior)
      return value.split(',').map(s => s.trim()).filter(s => s) as any[];
    }
  } else if (Array.isArray(value)) {
    return value;
  }
  return defaultValue;
}


export async function movieRowToDict(
    c: Context<{ Bindings: Env }>,
    row: any, // D1 row result
    db: D1Database // Pass the D1 instance for further queries if needed
  ): Promise<Partial<Movie> | null> {
  if (!row) return null;

  const data: Partial<Movie> = { ...row }; // Shallow copy

  data.genres = parseJsonField<string>(data.genres);
  data.tags = parseJsonField<string>(data.tags);
  // Actors from DB is complex: `[{ "name": "Actor Name", "role": "Role" }, ...]` as JSON string
  const actorsRaw = parseJsonField<any>(data.actors);
  data.actors_parsed_for_people = actorsRaw; // Store for People processing

  data.strm_files = parseJsonField<string | { url: string, path?: string }>(data.strm_files);


  // Emby-like fields
  data.Id = data.id;
  data.Name = data.title;
  data.Type = "Movie"; // Or "Series" based on set_name
  data.CommunityRating = data.rating;
  data.PremiereDate = data.premiered;
  data.RunTimeTicks = data.runtime ? data.runtime * 60 * 1000 * 10000 : undefined;
  data.SortName = data.title;
  data.is_liked = !!data.is_liked; // Convert 0/1 to boolean

  // Fetch collections the movie is part of
  if (data.id) {
    const collectionsStmt = db.prepare(`
        SELECT mc.id, mc.name FROM movie_collections mc
        JOIN movie_movie_collections mmc ON mc.id = mmc.collection_id
        WHERE mmc.movie_id = ?
    `);
    const collectionsResult = await collectionsStmt.bind(data.id).all();
    data.member_of_collections = collectionsResult.results as CollectionInfo[] || [];
  } else {
    data.member_of_collections = [];
  }


  // Image URLs (these need to point to your R2 serving endpoints)
  const MOVIE_API_PREFIX = '/api_movies'; // Keep consistent
  if (data.id) { // Use ID for image paths if available
    if (data.poster_file_path) { // poster_file_path should be the R2 key or part of it
        data.PrimaryImageTag = `${c.req.url.origin}${MOVIE_API_PREFIX}/images/poster/${data.id}`;
    }
    if (data.fanart_file_path) {
        data.BackdropImageTags = [`${c.req.url.origin}${MOVIE_API_PREFIX}/images/fanart/${data.id}`];
    }
  } else if (data.uniqueid_num) { // Fallback to uniqueid_num
     if (data.poster_file_path) {
        data.PrimaryImageTag = `${c.req.url.origin}${MOVIE_API_PREFIX}/images/poster/${data.uniqueid_num}`;
    }
    if (data.fanart_file_path) {
        data.BackdropImageTags = [`${c.req.url.origin}${MOVIE_API_PREFIX}/images/fanart/${data.uniqueid_num}`];
    }
  }


  data.People = [];
  if (data.actors_parsed_for_people) {
    data.actors_parsed_for_people.forEach((actorInfo: any) => {
      if (actorInfo && actorInfo.name) {
        const actorEntry: PersonInfo = {
          Name: actorInfo.name,
          Id: actorInfo.name, // Assuming name is ID for actors
          Type: 'Actor',
          Role: actorInfo.role,
        };
        // Actor thumb URL construction
        actorEntry.ImageTag = `${c.req.url.origin}${MOVIE_API_PREFIX}/images/actor_thumb/${encodeURIComponent(actorInfo.name)}`;
        data.People?.push(actorEntry);
      }
    });
  }

  // Directors
  // The Python code has `director` as a string or JSON.
  // Let's assume it can be a simple string or a JSON array of strings.
  let directors: string[] = [];
  if (typeof data.director === 'string') {
    try {
      const parsedDirector = JSON.parse(data.director);
      if (Array.isArray(parsedDirector)) {
        directors = parsedDirector.filter(d => typeof d === 'string');
      } else if (typeof parsedDirector === 'string') {
        directors = [parsedDirector];
      }
    } catch (e) {
      // Not JSON, assume it's a single director name string
      if (data.director) directors = [data.director];
    }
  }


  directors.forEach(directorName => {
    data.People?.push({ Name: directorName, Id: directorName, Type: 'Director' });
  });

  if (data.studio) {
    data.Studios = [{ Name: data.studio, Id: data.studio }];
  }

  data.Overview = data.plot;

  // Clean up temporary field
  delete data.actors_parsed_for_people;

  return data;
}

// You'll need buildMovieWhereClauseAndParams similar to Python
// This is complex and depends on how D1 handles LIKE with JSON.
// For D1, JSON functions like json_extract might be needed.
// Example: "genres LIKE '%"Adventure"%'" would be different in D1,
// perhaps "json_extract(genres, '$') LIKE '%Adventure%'" if genres is a JSON array string.
// Or you might normalize genres into a separate table.
// For now, I'll stub it, this part requires careful SQL translation for D1.
export function buildMovieWhereClauseAndParams(argsDict: Record<string, any>): { clause: string, params: any[] } {
  const conditions: string[] = [];
  const sqlParams: any[] = [];

  // SearchTerm: title, plot, director, studio, uniqueid_num, actors (actors is tricky with JSON)
  if (argsDict.SearchTerm) {
    const term = `%${argsDict.SearchTerm}%`;
    const searchConditions: string[] = [];
    searchConditions.push("title LIKE ?"); sqlParams.push(term);
    searchConditions.push("plot LIKE ?"); sqlParams.push(term);
    searchConditions.push("director LIKE ?"); sqlParams.push(term); // Assumes director is simple string or simple JSON array string
    searchConditions.push("studio LIKE ?"); sqlParams.push(term);
    searchConditions.push("uniqueid_num LIKE ?"); sqlParams.push(term);
    // Searching actors (JSON array of objects) with LIKE is hard.
    // You might need to use json_each or json_extract if actors is stored as a JSON string.
    // Example for JSON array of strings: "json_extract(actors, '$') LIKE ?"
    // For JSON array of objects: This is much harder with simple LIKE.
    // Often, this means denormalizing actor names into a separate searchable field or table.
    searchConditions.push("actors LIKE ?"); sqlParams.push(term); // This is a simplification
    conditions.push(`(${searchConditions.join(" OR ")})`);
  }

  if (argsDict.uniqueid_num_fuzzy) {
    conditions.push("uniqueid_num LIKE ?");
    sqlParams.push(`%${argsDict.uniqueid_num_fuzzy}%`);
  }
  if (argsDict.uniqueid_num_prefix) {
    conditions.push("uniqueid_num LIKE ?");
    sqlParams.push(`${argsDict.uniqueid_num_prefix}%`);
  }

  // Genres: Assuming 'genres' is a JSON array string like '["Action", "Adventure"]'
  if (argsDict.Genres) {
    const genreConditions: string[] = [];
    argsDict.Genres.split(',').forEach((genreToken: string) => {
      const genre = genreToken.trim();
      if (genre) {
        // This is a common way to check if a JSON array (stored as text) contains a value.
        // Adjust if your D1 schema stores genres differently (e.g., normalized table).
        genreConditions.push("genres LIKE ?"); // Simplified, real JSON search is more complex
        sqlParams.push(`%"${genre}"%`); // Matches "genre_name" within the JSON string
      }
    });
    if (genreConditions.length > 0) {
      conditions.push(`(${genreConditions.join(" OR ")})`);
    }
  }

  if (argsDict.ParentId) { // root_folder
    conditions.push("root_folder = ?");
    sqlParams.push(argsDict.ParentId);
  }

  // IncludeItemTypes: Movie (set_name is null/empty), Series (set_name is not null/empty)
  if (argsDict.IncludeItemTypes === "Movie") {
    conditions.push("(set_name IS NULL OR set_name = '')");
  } else if (argsDict.IncludeItemTypes === "Series") {
    conditions.push("(set_name IS NOT NULL AND set_name != '')");
  }

  // personIds: actor name or director name
  if (argsDict.personIds) {
    const personName = argsDict.personIds;
    // Simplified search for actors in JSON string and director as simple string
    // This will require more robust JSON searching in D1.
    const personConditions: string[] = [];
    personConditions.push("actors LIKE ?"); // Matches if actor name appears in the JSON string
    sqlParams.push(`%"name":"${personName}"%`); // More specific for {"name": "Actor Name"}
    personConditions.push("director = ?");
    sqlParams.push(personName);
    // If director can be a JSON array of strings:
    personConditions.push("director LIKE ?"); // for JSON array of strings
    sqlParams.push(`%"${personName}"%`);

    conditions.push(`(${personConditions.join(" OR ")})`);
  }

  if (argsDict.studioIds) { // studio name
    conditions.push("studio = ?");
    sqlParams.push(argsDict.studioIds);
  }

  if (argsDict.seriesName) {
    conditions.push("set_name = ?");
    sqlParams.push(argsDict.seriesName);
  }

  return {
    clause: conditions.length > 0 ? conditions.join(" AND ") : "1=1",
    params: sqlParams,
  };
}
