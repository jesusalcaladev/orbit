/**
 * Book API — domain layer.
 *
 * Pure TypeScript: the entities of the API and an in-memory repository. This
 * module knows nothing about Orbit, HTTP or frameworks — it is the "core" of
 * the example app. The engine layer (`./engine.ts`) adapts it to the Orbit
 * contract.
 */

export interface Author {
  id: string;
  name: string;
  country: string;
}

export interface Book {
  id: string;
  title: string;
  year: number;
  authorId: string;
}

export interface Review {
  id: string;
  bookId: string;
  rating: number; // 1..5
  text: string;
}

/** Seed data for the demo API — Spanish-language classics. */
function seed(): {
  authors: Author[];
  books: Book[];
  reviews: Review[];
} {
  return {
    authors: [
      { id: 'a1', name: 'Ana', country: 'España' },
      { id: 'a2', name: 'Bruno', country: 'México' },
      { id: 'a3', name: 'Cara', country: 'Argentina' },
    ],
    books: [
      { id: 'b1', title: 'Don Quijote de la Mancha', year: 1605, authorId: 'a1' },
      { id: 'b2', title: 'Rayuela', year: 1963, authorId: 'a2' },
      { id: 'b3', title: 'Ficciones', year: 1944, authorId: 'a3' },
      { id: 'b4', title: 'La casa de los espíritus', year: 1982, authorId: 'a3' },
    ],
    reviews: [
      { id: 'r1', bookId: 'b1', rating: 5, text: 'La mejor novela de la lengua española' },
      { id: 'r2', bookId: 'b1', rating: 4, text: 'Un clásico imprescindible' },
      { id: 'r3', bookId: 'b2', rating: 5, text: 'Cortázar en estado puro' },
      { id: 'r4', bookId: 'b4', rating: 4, text: 'Mágico y conmovedor' },
    ],
  };
}

/**
 * In-memory repository: the single place that owns the data. Queries return
 * fresh copies (callers can never mutate the store); mutations validate input
 * and throw plain `Error`s with user-facing messages — the engine layer maps
 * those onto protocol errors.
 */
export class BookRepository {
  private readonly authors = new Map<string, Author>();
  private readonly books = new Map<string, Book>();
  private readonly reviews = new Map<string, Review>();
  /** Domain change notifications — powers the realtime demo. */
  private readonly reviewListeners = new Set<(review: Review) => void>();
  private seq = 0;

  constructor() {
    const { authors, books, reviews } = seed();
    for (const author of authors) this.authors.set(author.id, author);
    for (const book of books) this.books.set(book.id, book);
    for (const review of reviews) this.reviews.set(review.id, review);
    // New ids continue after the seeded ones (b1–b4 / r1–r4).
    const maxNumeric = (items: Array<{ id: string }>) =>
      items.reduce((max, item) => Math.max(max, Number(item.id.slice(1)) || 0), 0);
    this.seq = Math.max(maxNumeric(books), maxNumeric(reviews));
  }

  // -- queries --------------------------------------------------------------

  allAuthors(): Author[] {
    return [...this.authors.values()];
  }

  authorById(id: string): Author | undefined {
    return this.authors.get(id);
  }

  allBooks(): Book[] {
    return [...this.books.values()];
  }

  bookById(id: string): Book | undefined {
    return this.books.get(id);
  }

  booksByAuthor(authorId: string): Book[] {
    return [...this.books.values()].filter((book) => book.authorId === authorId);
  }

  allReviews(): Review[] {
    return [...this.reviews.values()];
  }

  reviewById(id: string): Review | undefined {
    return this.reviews.get(id);
  }

  reviewsByBook(bookId: string): Review[] {
    return [...this.reviews.values()].filter((review) => review.bookId === bookId);
  }

  /** Subscribe to review creations; returns an unsubscribe function. */
  onReviewAdded(callback: (review: Review) => void): () => void {
    this.reviewListeners.add(callback);
    return () => this.reviewListeners.delete(callback);
  }

  // -- mutations (validated; throw Error with a user-facing message) --------

  createBook(input: { title: string; year: number; authorId: string }): Book {
    const title = input.title.trim();
    if (title.length === 0) throw new Error('Book title cannot be empty');
    if (!Number.isInteger(input.year) || input.year < 1000 || input.year > 2100) {
      throw new Error('Year must be an integer between 1000 and 2100');
    }
    const author = this.authors.get(input.authorId);
    if (!author) throw new Error(`Unknown author '${input.authorId}'`);

    const book: Book = { id: this.nextId('b'), title, year: input.year, authorId: author.id };
    this.books.set(book.id, book);
    return book;
  }

  addReview(input: { bookId: string; rating: number; text: string }): Review {
    if (!this.books.has(input.bookId)) throw new Error(`Unknown book '${input.bookId}'`);
    if (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5) {
      throw new Error('Rating must be an integer between 1 and 5');
    }
    const text = input.text.trim();
    if (text.length === 0) throw new Error('Review text cannot be empty');

    const review: Review = {
      id: this.nextId('r'),
      bookId: input.bookId,
      rating: input.rating,
      text,
    };
    this.reviews.set(review.id, review);
    for (const callback of this.reviewListeners) callback(review);
    return review;
  }

  /** Removes a book and its reviews (cascade). Returns false when unknown. */
  removeBook(id: string): boolean {
    if (!this.books.delete(id)) return false;
    for (const [reviewId, review] of this.reviews) {
      if (review.bookId === id) this.reviews.delete(reviewId);
    }
    return true;
  }

  private nextId(prefix: 'b' | 'r'): string {
    this.seq += 1;
    return `${prefix}${this.seq}`;
  }
}
