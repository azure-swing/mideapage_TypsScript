import { Hono } from 'hono';
import { Env, Manga, CollectionInfo } from './types';
import { getClientIp } from './auth';
import { parseJsonField } from './dbUtils'; // You might need manga-specific version if return is different

export const mangaApiApp = new Hono<{ Bindings: Env }>();

// GET /api/mangas
mangaApiApp.get('/mangas', async (c) => {
    const query = c.req.query();
    const searchTerm = query['search_term'];
    const sortBy = query['sort_by'] || 'title_asc';
    const collectionId = query['collection_id'] ? parseInt(query['collection_id'], 10) : undefined;
    const author = query['author'];
    const page = parseInt(query['page'] || '1', 10);
    const perPage = parseInt(query['per_page'] || '40', 10);

    let selectClause = "SELECT DISTINCT m.*";
    let countSelectClause = "SELECT COUNT(DISTINCT m.id) as total";
    let fromClause = " FROM mangas m";
    const conditions: string[] = ["m.is_appendix_to IS NULL"]; // Important default filter
    const params: any[] = [];

    if (collectionId) {
        fromClause += " JOIN manga_collections mc ON m.id = mc.manga_id";
        conditions.push("mc.collection_id = ?");
        params.push(collectionId);
    }
    if (author) {
        conditions.push("m.author = ?");
        params.push(author);
    }
    if (searchTerm && !author) { // Search term only if not filtering by specific author on this endpoint
        conditions.push("(m.title LIKE ? OR m.author LIKE ?)");
        params.push(`%${searchTerm}%`, `%${searchTerm}%`);
    }
    
    const whereClause = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : "";

    const countQuery = c.env.MANGA_DB.prepare(countSelectClause + fromClause + whereClause);
    const totalResult = await countQuery.bind(...params).first<{ total: number }>();
    const totalMangas = totalResult?.total || 0;

    const orderMap: Record<string, string> = {
        'title_asc': "m.title ASC",
        'title_desc': "m.title DESC",
        'id_desc': "m.id DESC",
        'id_asc': "m.id ASC",
        'page_count_desc': "m.page_count DESC, m.title ASC",
        'page_count_asc': "m.page_count ASC, m.title ASC",
    };
    const orderByClause = ` ORDER BY ${orderMap[sortBy] || orderMap['title_asc']}`;
    const limitOffsetClause = ` LIMIT ${perPage} OFFSET ${(page - 1) * perPage}`;

    const dataQuery = c.env.MANGA_DB.prepare(selectClause + fromClause + whereClause + orderByClause + limitOffsetClause);
    const mangasRawResult = await dataQuery.bind(...params).all<Manga>();
    const mangasRaw = mangasRawResult.results || [];

    const mangasPromises = mangasRaw.map(async (mangaDb: any) => {
        const manga: Partial<Manga> = { ...mangaDb };
        manga.is_favorited = !!manga.is_favorited;
        if (manga.path && manga.cover_image) {
            // Construct cover image URL (points to R2 via our image serving route)
            // Example: /data/manga_images/MangaFolderName/cover.jpg
             manga.cover_image_url = `${c.req.url.origin}/data/manga_images/${manga.path}/${manga.cover_image}`;
        }
        return manga;
    });
    const mangas = await Promise.all(mangasPromises);

    return c.json({
        mangas,
        total_mangas: totalMangas,
        current_page: page,
        per_page: perPage,
        total_pages: Math.ceil(totalMangas / perPage) || 0,
    });
});

// GET /api/manga_item/:item_id
mangaApiApp.get('/manga_item/:item_id', async (c) => {
    const itemId = parseInt(c.req.param('item_id'), 10);
    const clientIp = getClientIp(c);

    if (isNaN(itemId)) return c.json({ error: "Invalid item ID" }, 400);

    const mangaRaw = await c.env.MANGA_DB.prepare("SELECT * FROM mangas WHERE id = ?").bind(itemId).first<Manga>();
    if (!mangaRaw) return c.json({ error: "Manga not found" }, 404);

    const manga: Partial<Manga> = { ...mangaRaw };
    manga.is_favorited = !!manga.is_favorited;

    // Log activity
    console.info(`${clientIp} - Viewed manga details: '${manga.title}' (ID: ${itemId})`);

    if (manga.path && manga.cover_image) {
        manga.cover_image_url = `${c.req.url.origin}/data/manga_images/${manga.path}/${manga.cover_image}`;
    }
    
    const pagesList = parseJsonField<string>(manga.pages_json);
    manga.image_urls = pagesList.map(pageFile => 
        `${c.req.url.origin}/data/manga_images/${manga.path}/${pageFile}`
    );

    // Fetch appendices
    const appendicesResult = await c.env.MANGA_DB.prepare(
        "SELECT id, title, page_count FROM mangas WHERE is_appendix_to = ? ORDER BY title"
    ).bind(itemId).all<{id:number, title:string, page_count:number}>();
    manga.appendices = (appendicesResult.results || []).map(app => ({
        ...app,
        // Optionally construct cover URLs for appendices if they have them
    }));


    // Fetch collections
    const collectionsResult = await c.env.MANGA_DB.prepare(`
        SELECT c.id, c.name FROM collections c
        JOIN manga_collections mc ON c.id = mc.collection_id WHERE mc.manga_id = ?
    `).bind(itemId).all<CollectionInfo>();
    manga.member_of_collections = collectionsResult.results || [];

    return c.json(manga);
});

// POST /api/manga_item/:item_id/favorite
mangaApiApp.post('/manga_item/:item_id/favorite', async (c) => {
    const itemId = parseInt(c.req.param('item_id'), 10);
    const clientIp = getClientIp(c);
    const payload = await c.req.json<{ favorited: boolean }>();

    if (isNaN(itemId)) return c.json({ error: "Invalid item ID" }, 400);
    if (typeof payload.favorited !== 'boolean') {
        return c.json({ error: "Invalid request body: 'favorited' boolean field is required." }, 400);
    }
    
    const mangaInfo = await c.env.MANGA_DB.prepare("SELECT id, title FROM mangas WHERE id = ?").bind(itemId).first<{id: number, title: string}>();
    if (!mangaInfo) return c.json({ error: "Manga not found" }, 404);

    const newStatusDb = payload.favorited ? 1 : 0;
    const action = payload.favorited ? "Favorited" : "Unfavorited";

    try {
        await c.env.MANGA_DB.prepare("UPDATE mangas SET is_favorited = ? WHERE id = ?")
            .bind(newStatusDb, itemId)
            .run();
        console.info(`${clientIp} - ${action} manga: '${mangaInfo.title}' (ID: ${itemId})`);
        return c.json({ message: `Manga ${action.toLowerCase()}`, is_favorited: payload.favorited });
    } catch (e: any) {
        console.error(`Error toggling favorite for manga ${itemId}: ${e.message}`);
        return c.json({ error: "Database error", details: e.message }, 500);
    }
});


// ... other manga API endpoints (collections)
