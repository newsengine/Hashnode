/* eslint-disable @typescript-eslint/no-unused-vars */
import { TRPCError } from "@trpc/server";
import {
  and,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  lt,
  lte,
  or,
} from "drizzle-orm";
import { type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { Session } from "next-auth";
import readingTime from "reading-time";
import slugify from "slugify";
import { v4 as uuid } from "uuid";
import { z } from "zod";
import { FILTER_TIME_OPTIONS } from "~/hooks/useFilter";
import {
  createTRPCRouter,
  protectedProcedure,
  publicProcedure,
} from "~/server/api/trpc";
import type * as schemaFile from "~/server/db/schema";
import {
  articles,
  comments,
  customTabs,
  follow,
  handles,
  likesToArticles,
  likesToComment,
  newArticleSchema,
  notifications,
  readersToArticles,
  series,
  tags,
  tagsToArticles,
  tagsToUsers,
  users,
} from "~/server/db/schema";
import type { ArticleCardWithComments, SearchResults } from "~/types";
import {
  displayUniqueObjects,
  selectArticleCard,
  slugSetting,
} from "~/utils/constants";
import {
  refactorActivityHelper,
  type Activity,
} from "./../../../utils/microFunctions";

const getArticlesWithUserFollowingimages = async (
  ctx: {
    session: Session | null;
    db: PostgresJsDatabase<typeof schemaFile>;
  },
  articles: ArticleCardWithComments[]
) => {
  // If user is logged in, get the user's following images else return empty array for commenUsers
  // Retrieve user following outside the loop
  const userFollowing = ctx.session?.user
    ? await ctx.db.query.users.findFirst({
        where: eq(users.id, ctx.session.user.id),
        with: {
          following: {
            columns: {
              userId: true,
            },
          },
        },
      })
    : null;

  // Combine the mapping logic into a single loop
  const updatedArticles = articles.map((article) => {
    const { comments, ...rest } = article;
    let followingComments: {
      id: string;
      image: string | null;
    }[] = [];

    if (userFollowing) {
      followingComments = displayUniqueObjects(
        comments
          .map((c) => c.user)
          .filter((user) =>
            userFollowing.following.some((f) => f.userId === user.id)
          )
      );
    }

    return { ...rest, commonUsers: followingComments };
  });

  // Handle the case when ctx.session.user is not present
  if (!ctx.session?.user) {
    updatedArticles.forEach((article) => {
      article.commonUsers = [];
    });
  }

  return updatedArticles;
};

export const postsRouter = createTRPCRouter({
  deleteAll: publicProcedure.mutation(async ({ ctx }) => {
    await ctx.db.delete(customTabs);
    await ctx.db.delete(series);
    await ctx.db.delete(tagsToUsers);
    await ctx.db.delete(handles);
    await ctx.db.delete(tagsToArticles);
    await ctx.db.delete(tags);
    await ctx.db.delete(articles);
    await ctx.db.delete(follow);
    await ctx.db.delete(users);
    await ctx.db.delete(comments);
    await ctx.db.delete(notifications);
    await ctx.db.delete(likesToArticles);
    await ctx.db.delete(likesToComment);
    return {
      success: true,
    };
  }),

  // TODO: Add pagination/infinite scroll feature.
  // TODO: Add following feature.
  getAll: publicProcedure
    .input(
      z.object({
        limit: z.number().optional().default(6),
        filter: z
          .object({
            read_time: z.enum(["UNDER_5", "5", "OVER_5"]).nullable().optional(),
            tags: z.array(z.string()),
          })
          .optional()
          .nullable(),
        type: z
          .enum(["PERSONALIZED", "FOLLOWING", "LATEST"])
          .optional()
          .default("PERSONALIZED"),
      })
    )
    .query(async ({ ctx, input }) => {
      try {
        if (input.type === "FOLLOWING") {
          if (!ctx.session?.user?.id) {
            throw new TRPCError({
              code: "NOT_FOUND",
              message: "Login to see your following feed",
            });
          }

          const followings = await ctx.db.query.users.findFirst({
            where: eq(users.id, ctx.session.user.id),
            columns: {
              id: true,
            },
            with: {
              following: {
                columns: {
                  userId: true,
                },
              },
            },
          });

          if (!followings) {
            throw new TRPCError({
              code: "NOT_FOUND",
              message: "Login to see your following feed",
            });
          }

          const { following } = followings;

          if (following.length === 0) {
            throw new TRPCError({
              code: "NOT_FOUND",
              message: "Follow some users to see their articles",
            });
          }

          const result = await ctx.db.query.articles
            .findMany({
              where: and(
                eq(articles.isDeleted, false),
                ...(input?.filter?.read_time
                  ? input.filter.read_time === "OVER_5"
                    ? [gt(articles.read_time, 5)]
                    : input.filter.read_time === "UNDER_5"
                    ? [lt(articles.read_time, 5)]
                    : input.filter.read_time === "5"
                    ? [eq(articles.read_time, 5)]
                    : []
                  : []),
                inArray(
                  articles.userId,
                  following.flatMap((e) => e.userId)
                )
              ),
              limit: input.limit,
              ...selectArticleCard,
              orderBy: [
                desc(articles.likesCount),
                desc(articles.commentsCount),
                desc(articles.readCount),
              ],
            })
            .then((article) =>
              article
                .map((ele) => ({ ...ele, tags: ele.tags.map((e) => e.tag) }))
                .filter((article) => {
                  if (input?.filter?.tags) {
                    return input?.filter?.tags.every((tag) =>
                      article.tags.some((e) => e.name === tag)
                    );
                  } else {
                    return true;
                  }
                })
            );

          const formattedPosts = await getArticlesWithUserFollowingimages(
            {
              session: ctx.session,
              db: ctx.db,
            },
            result
          );

          return {
            posts: formattedPosts,
          };
        }

        const result = await ctx.db.query.articles
          .findMany({
            where: and(
              eq(articles.isDeleted, false),
              ...(input?.filter?.read_time
                ? input.filter.read_time === "OVER_5"
                  ? [gt(articles.read_time, 5)]
                  : input.filter.read_time === "UNDER_5"
                  ? [lt(articles.read_time, 5)]
                  : input.filter.read_time === "5"
                  ? [eq(articles.read_time, 5)]
                  : []
                : [])
            ),

            orderBy:
              input?.type === "LATEST"
                ? [desc(articles.createdAt)]
                : [
                    desc(articles.likesCount),
                    desc(articles.commentsCount),
                    desc(articles.readCount),
                  ],

            ...selectArticleCard,
          })
          .then((article) =>
            article
              .map((ele) => ({ ...ele, tags: ele.tags.map((e) => e.tag) }))
              .filter((article) => {
                if (input?.filter?.tags) {
                  return input?.filter?.tags.every((tag) =>
                    article.tags.some((e) => e.name === tag)
                  );
                } else {
                  return true;
                }
              })
          );

        const formattedPosts = await getArticlesWithUserFollowingimages(
          {
            session: ctx.session,
            db: ctx.db,
          },
          result
        );

        return {
          posts: formattedPosts,
        };
      } catch (err) {
        if (err instanceof TRPCError) {
          throw err;
        }
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Something went wrong, try again later",
        });
      }
    }),

  getArticlesUsingTag: publicProcedure
    .input(
      z.object({
        name: z.string().trim(),
        filter: z
          .object({
            read_time: z.enum(["UNDER_5", "5", "OVER_5"]).nullable(),
            tags: z.array(z.string().trim()),
          })
          .optional(),
        limit: z.number().optional().default(6),
        type: z.enum(["hot", "new"]).optional().default("new"),
      })
    )
    .query(async ({ ctx, input }) => {
      const { limit } = input;

      const res = await ctx.db.query.tags
        .findFirst({
          where: eq(tags.slug, input.name),
          columns: {
            id: true,
          },
          with: {
            articles: {
              limit: limit,
              with: {
                article: {
                  ...selectArticleCard,
                },
              },
            },
          },
        })
        .then((res) => {
          if (res) {
            return res.articles
              .map(({ article }) => ({
                ...article,
                tags: article.tags.map((e) => e.tag),
              }))
              .sort((a, b) => {
                if (input.type === "hot") {
                  return b.likesCount - a.likesCount;
                } else {
                  return (
                    new Date(b.createdAt).getTime() -
                    new Date(a.createdAt).getTime()
                  );
                }
              });
          }
        });

      if (!res) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Tag not found",
        });
      }
      const formattedPosts = await getArticlesWithUserFollowingimages(
        {
          session: ctx.session,
          db: ctx.db,
        },
        res
      );

      return {
        posts: formattedPosts,
      };
    }),

  getMany: publicProcedure
    .input(
      z.object({
        ids: z
          .array(z.object({ id: z.string().trim() }))
          .optional()
          .default([]),
      })
    )
    .query(async ({ ctx, input }) => {
      const articlesData = await ctx.db.query.articles
        .findMany({
          ...selectArticleCard,
          limit: 15,
          where: and(
            eq(articles.isDeleted, false),
            inArray(
              articles.id,
              input.ids.map((id) => id.id)
            )
          ),
        })
        .then((res) =>
          res.map((ele) => ({ ...ele, tags: ele.tags.map((e) => e.tag) }))
        );

      return await getArticlesWithUserFollowingimages(
        {
          session: ctx.session,
          db: ctx.db,
        },
        articlesData
      );
    }),

  getBookmarks: publicProcedure
    .input(
      z.object({
        ids: z
          .array(z.object({ id: z.string().trim() }))
          .optional()
          .default([]),
      })
    )
    .query(async ({ ctx, input }) => {
      try {
        const res = await ctx.db.query.articles.findMany({
          where: and(
            eq(articles.isDeleted, false),
            inArray(
              articles.id,
              input.ids.map((id) => id.id)
            )
          ),
          with: {
            user: {
              columns: {
                name: true,
                stripeSubscriptionStatus: true,
                username: true,
              },
            },
          },
          columns: {
            id: true,
            read_time: true,
            title: true,
            slug: true,
          },
          limit: 4,
        });

        return res;
      } catch (err) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Something went wrong, try again later",
        });
      }
    }),

  getSingleArticle: publicProcedure
    .input(
      z.object({
        slug: z.string().trim(),
      })
    )
    .query(async ({ ctx, input }) => {
      try {
        const article = await ctx.db.query.articles
          .findFirst({
            with: {
              user: {
                with: {
                  followers: {
                    where: eq(follow.followingId, ctx.session?.user?.id || ""),
                    columns: {
                      userId: true,
                    },
                  },
                },
              },
              series: {
                columns: {
                  title: true,
                  slug: true,
                },
              },
              tags: {
                with: {
                  tag: {
                    columns: {
                      id: true,
                      name: true,
                      slug: true,
                    },
                  },
                },
              },
              likes: {
                columns: {
                  userId: true,
                },
              },
            },
            where: and(
              eq(articles.isDeleted, false),
              eq(articles.slug, input.slug)
            ),
          })
          .then((res) => ({ ...res, tags: res?.tags.map((e) => e.tag) }));

        if (!article || !article.user) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Article not found",
          });
        }

        const { followers: _, ...rest } = article.user;

        if (ctx.session?.user) {
          return {
            ...article,
            isFollowing: article.user.followers.length > 0,
            user: rest,
          };
        } else {
          return {
            ...article,
            isFollowing: false,
            user: rest,
          };
        }
      } catch (err) {
        if (err instanceof TRPCError) {
          throw err;
        } else {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Something went wrong, try again later",
          });
        }
      }
    }),

  getArticleToEdit: protectedProcedure
    .input(
      z.object({
        slug: z.string(),
      })
    )
    .query(async ({ ctx, input }) => {
      try {
        const article = await ctx.db.query.articles.findFirst({
          where: and(
            eq(articles.slug, input.slug),
            eq(articles.isDeleted, false)
          ),
          columns: {
            title: true,
            subtitle: true,
            content: true,
            cover_image: true,
            cover_image_key: true,
            slug: true,
            seoTitle: true,
            disabledComments: true,
            seoDescription: true,
            seoOgImage: true,
            userId: true,
            seoOgImageKey: true,
            seriesId: true,
          },
          with: {
            series: {
              columns: {
                id: true,
                title: true,
              },
            },
            tags: {
              with: {
                tag: {
                  columns: {
                    name: true,
                  },
                },
              },
            },
          },
        });

        if (!article) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Article not found",
          });
        }

        if (article.userId !== ctx.session.user.id) {
          throw new TRPCError({
            code: "UNAUTHORIZED",
            message: "You are not authorized to edit this article",
          });
        }

        return {
          ...article,
          tags: article.tags.map((e) => e.tag.name),
          series: article.series?.title || null,
          seoTitle: article.seoTitle || "",
          seoDescription: article.seoDescription || "",
        };
      } catch (err) {
        if (err instanceof TRPCError) {
          throw err;
        } else {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Something went wrong, try again later",
          });
        }
      }
    }),

  new: protectedProcedure
    .input(
      newArticleSchema.merge(
        z.object({
          edit: z.boolean(), //? article is being edited or created
          prev_slug: z.string().optional().nullable(),
          tags: z.array(z.string().trim()).default([]),
        })
      )
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const existingArticle = await ctx.db.query.articles.findFirst({
          where: eq(articles.slug, input.prev_slug || input.slug),
          columns: {
            id: true,
            userId: true,
          },
          with: {
            tags: {
              with: {
                tag: {
                  columns: {
                    name: true,
                  },
                },
              },
            },
          },
        });

        // check for not registered tags
        let allTags: {
            id: string;
            articlesCount: number;
          }[] = [],
          allTagsDetails: {
            id: string;
            articlesCount: number;
            name: string;
          }[] = [];

        if (input.tags.length > 0) {
          allTags = await ctx.db
            .insert(tags)
            .values([
              ...input.tags.map((tag) => ({
                name: tag,
                slug: slugify(tag, slugSetting),
              })),
            ])
            .onConflictDoNothing()
            .returning({
              id: tags.id,
              articlesCount: tags.articlesCount,
            });

          allTagsDetails = await ctx.db.query.tags.findMany({
            where: inArray(tags.name, input.tags),
            columns: {
              id: true,
              articlesCount: true,
              name: true,
            },
          });

          // update article count;
          await Promise.all(
            allTagsDetails.map(async (detail) => {
              await ctx.db
                .update(tags)
                .set({
                  articlesCount: detail.articlesCount + 1,
                })
                .where(eq(tags.id, detail.id));
            })
          );
        }

        const { edit, tags: _, ...rest } = input;

        if (edit && existingArticle) {
          delete rest.prev_slug;
          // editing an article

          if (existingArticle.userId !== ctx.session.user.id) {
            throw new TRPCError({
              code: "UNAUTHORIZED",
              message: "You are not authorized to edit this article",
            });
          }

          const [updatedArticle] = await ctx.db
            .update(articles)
            .set({
              ...rest,
              read_time: Math.ceil(readingTime(input.content).minutes) || 1,
              seoTitle: input.seoTitle || input.title,
              seoDescription:
                input.seoDescription ||
                input.subtitle ||
                input.content.slice(0, 40),
              seoOgImage: input.seoOgImage || input.cover_image,
            })
            .where(and(eq(articles.id, existingArticle.id)))
            .returning({
              id: articles.id,
              slug: articles.slug,
            });

          if (!updatedArticle) {
            throw new TRPCError({
              code: "NOT_FOUND",
              message: "Article not found",
            });
          }

          if (allTagsDetails.length > 0) {
            await ctx.db
              .insert(tagsToArticles)
              .values(
                allTagsDetails.map((tag) => ({
                  articleId: updatedArticle.id,
                  tagId: tag.id,
                }))
              )
              .onConflictDoNothing();
          }

          // update article count;
          if (allTags.length > 0) {
            await ctx.db
              .update(tags)
              .set({
                articlesCount:
                  (allTags.find((e) => e.id === tags.id._.data)
                    ?.articlesCount ?? 0) + 1,
              })
              .where(
                inArray(
                  tags.id,
                  allTags.map((e) => e.id)
                )
              );
          }

          return {
            success: true,
            redirectLink: `/u/@${ctx.session.user.username}/${updatedArticle.slug}`,
          };
        } else {
          // creating article
          const [newArticle] = await ctx.db
            .insert(articles)
            .values({
              ...rest,
              userId: ctx.session.user.id,
              read_time: Math.ceil(readingTime(input.content).minutes) || 1,
              slug: input.slug,
              seoTitle: input.seoTitle || input.title,
              seoDescription:
                input.seoDescription ||
                input.subtitle ||
                input.content.slice(0, 40),
              seoOgImage: input.seoOgImage || input.cover_image,
            })
            .returning();

          if (!newArticle) {
            return {
              success: false,
              redirectLink: null,
            };
          }

          if (allTagsDetails.length > 0) {
            await ctx.db
              .insert(tagsToArticles)
              .values(
                allTagsDetails.map((tag) => ({
                  articleId: newArticle.id,
                  tagId: tag.id,
                }))
              )
              .onConflictDoNothing();
          }

          const result = await ctx.db.query.articles.findFirst({
            where: eq(articles.id, newArticle.id),
            columns: {
              slug: true,
            },
            with: {
              user: {
                columns: {
                  id: true,
                },
                with: {
                  followers: {
                    columns: {
                      followingId: true,
                    },
                  },
                },
              },
            },
          });

          if (result?.user.followers && result.user.followers.length > 0) {
            await ctx.db.insert(notifications).values(
              result?.user.followers.map((follower) => ({
                userId: follower.followingId,
                fromId: ctx.session.user.id,
                articleId: newArticle.id,
                type: "ARTICLE",
                body: `@${ctx.session.user.username} published a new article.`,
                title: newArticle.title,
                slug: newArticle.slug,
              }))
            );
          }

          return {
            success: true,
            redirectLink: `/u/@${ctx.session.user.username}/${
              result?.slug as string
            }`,
          };
        }
      } catch (err) {
        console.log({ err });
        if (err instanceof TRPCError) {
          throw err;
        } else {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Something went wrong, try again later",
          });
        }
      }
    }),

  getRecentActivity: publicProcedure
    .input(z.object({ username: z.string() }))
    .query(async ({ ctx, input }) => {
      const user = await ctx.db.query.users.findFirst({
        where: eq(
          users.username,
          input.username.slice(1, input.username.length)
        ),
        columns: {
          createdAt: true,
          id: true,
        },
      });

      if (!user) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "User not found",
        });
      }

      const activities = await ctx.db.query.articles.findMany({
        with: {
          user: {
            columns: {
              username: true,
            },
          },
        },
        where: and(eq(articles.isDeleted, false), eq(articles.userId, user.id)),
        columns: {
          id: true,
          title: true,
          slug: true,
          createdAt: true,
          userId: true,
        },
        limit: 10,
        orderBy: [desc(articles.createdAt)],
      });

      // refactor using refactorActivityHelper
      const newActivities = activities.map((e) => ({
        ...e,
        activity_type: "ARTICLE",
      })) as Activity[];

      const refactoredActivities = refactorActivityHelper([
        ...newActivities,
        {
          id: uuid(),
          title: "Joined Hashnode Clone",
          slug: "",
          createdAt: user?.createdAt,
          activity_type: "JOINED",
        },
      ]);
      return Array.from(refactoredActivities);
    }),

  search: publicProcedure
    .input(
      z.object({
        type: z.enum(["TOP", "ARTICLES", "TAGS", "USERS", "LATEST"]),
        query: z.string().trim(),
      })
    )
    .query(async ({ ctx, input }) => {
      const result: SearchResults = {
        users: null,
        tags: null,
        articles: null,
      };

      switch (input.type) {
        case "ARTICLES":
          const articlesData = await ctx.db.query.articles.findMany({
            where: and(
              eq(articles.isDeleted, false),
              or(
                ilike(articles.title, `%${input.query}%`),
                ilike(articles.slug, `%${input.query}%`),
                ilike(articles.subtitle, `%${input.query}%`)
              )
            ),
            columns: {
              id: true,
              title: true,
              slug: true,
              cover_image: true,
              likesCount: true,
              commentsCount: true,
              createdAt: true,
              updatedAt: true,
            },
            with: {
              user: {
                columns: {
                  id: true,
                  name: true,
                  username: true,
                  image: true,
                  stripeSubscriptionStatus: true,
                },
              },
            },
            orderBy: [
              desc(articles.likesCount),
              desc(articles.commentsCount),
              desc(articles.createdAt),
            ],
            limit: 7,
          });
          result.articles = articlesData;
          break;

        case "TAGS":
          const tagsData = await ctx.db.query.tags.findMany({
            where: or(
              ilike(tags.name, `%${input.query}%`),
              ilike(tags.slug, `%${input.query}%`),
              ilike(tags.description, `%${input.query}%`)
            ),
            columns: {
              id: true,
              name: true,
              slug: true,
            },
            with: {
              followers: {
                where: eq(tagsToUsers.userId, ctx.session?.user?.id || ""),
                columns: {
                  userId: true,
                },
              },
            },
            orderBy: [desc(tags.followersCount)],
            limit: 7,
          });

          result.tags = tagsData.map((details) => {
            const { followers, ...rest } = details;
            return {
              ...rest,
              isFollowing: followers.length > 0,
            };
          });
          break;

        case "USERS":
          const usersData = await ctx.db.query.users.findMany({
            with: {
              followers: {
                where: eq(follow.followingId, ctx.session?.user?.id || ""),
                columns: {
                  userId: false,
                },
              },
            },
            columns: {
              id: true,
              name: true,
              username: true,
              stripeSubscriptionStatus: true,
              image: true,
            },
            where: or(
              ilike(users.name, `%${input.query}%`),
              ilike(users.username, `%${input.query}%`),
              ilike(users.bio, `%${input.query}%`),
              ilike(users.email, `%${input.query}%`)
            ),
            orderBy: [desc(users.followersCount)],
            limit: 7,
          });

          result.users = usersData.map((details) => {
            const { followers, ...rest } = details;
            return {
              ...rest,
              isFollowing: followers.length > 0,
              isAuthor: details.id === ctx.session?.user?.id,
            };
          });
          break;

        case "LATEST":
          const latestArticlesData = ctx.db.query.articles.findMany({
            where: and(
              eq(articles.isDeleted, false),
              or(
                ilike(articles.title, `%${input.query}%`),
                ilike(articles.slug, `%${input.query}%`),
                ilike(articles.subtitle, `%${input.query}%`)
              )
            ),
            columns: {
              id: true,
              title: true,
              slug: true,
              cover_image: true,
              read_time: true,
              likesCount: true,
              commentsCount: true,
              createdAt: true,
              updatedAt: true,
            },
            with: {
              user: {
                columns: {
                  id: true,
                  name: true,
                  username: true,
                  image: true,
                  stripeSubscriptionStatus: true,
                },
              },
            },
            orderBy: [desc(articles.createdAt)],
            limit: 7,
          });

          const latestTagsData = ctx.db.query.tags.findMany({
            where: or(
              ilike(tags.name, `%${input.query}%`),
              ilike(tags.slug, `%${input.query}%`),
              ilike(tags.description, `%${input.query}%`)
            ),
            columns: {
              id: true,
              name: true,
              slug: true,
            },
            with: {
              followers: {
                where: eq(tagsToUsers.userId, ctx.session?.user?.id || ""),
                columns: {
                  userId: true,
                },
              },
            },
            orderBy: [desc(tags.followersCount)],
            limit: 7,
          });

          const [latestArticles, latestTags] = await Promise.all([
            latestArticlesData,
            latestTagsData,
          ]);

          result.articles = latestArticles;
          result.tags = latestTags.map((details) => {
            const { followers, ...rest } = details;
            return {
              ...rest,
              isFollowing: followers.length > 0,
            };
          });

          break;

        case "TOP":
          const topArticlesData = ctx.db.query.articles.findMany({
            where: and(
              eq(articles.isDeleted, false),
              or(
                ilike(articles.title, `%${input.query}%`),
                ilike(articles.slug, `%${input.query}%`),
                ilike(articles.subtitle, `%${input.query}%`)
              )
            ),
            orderBy: [
              desc(articles.likesCount),
              desc(articles.commentsCount),
              desc(articles.createdAt),
            ],
            columns: {
              id: true,
              title: true,
              slug: true,
              cover_image: true,
              read_time: true,
              likesCount: true,
              commentsCount: true,
              createdAt: true,
              updatedAt: true,
            },
            with: {
              user: {
                columns: {
                  id: true,
                  name: true,
                  username: true,
                  image: true,
                  stripeSubscriptionStatus: true,
                },
              },
            },
            limit: 7,
          });

          const topTagsData = ctx.db.query.tags.findMany({
            where: or(
              ilike(tags.name, `%${input.query}%`),
              ilike(tags.slug, `%${input.query}%`),
              ilike(tags.description, `%${input.query}%`)
            ),
            columns: {
              id: true,
              name: true,
              slug: true,
            },
            with: {
              followers: {
                where: eq(tagsToUsers.userId, ctx.session?.user?.id || ""),
                columns: {
                  userId: true,
                },
              },
            },
            orderBy: [desc(tags.followersCount), desc(tags.articlesCount)],
            limit: 7,
          });

          const topUsersData = ctx.db.query.users.findMany({
            with: {
              followers: {
                where: eq(follow.followingId, ctx.session?.user?.id || ""),
                columns: {
                  userId: false,
                },
              },
            },
            columns: {
              id: true,
              name: true,
              username: true,
              stripeSubscriptionStatus: true,
              image: true,
            },
            where: or(
              ilike(users.name, `%${input.query}%`),
              ilike(users.username, `%${input.query}%`),
              ilike(users.bio, `%${input.query}%`),
              ilike(users.email, `%${input.query}%`)
            ),
            orderBy: [desc(users.followersCount)],
            limit: 7,
          });

          const [topArticles, topTags, topUsers] = await Promise.all([
            topArticlesData,
            topTagsData,
            topUsersData,
          ]);

          result.articles = topArticles;
          result.tags = topTags.map((details) => {
            const { followers, ...rest } = details;
            return {
              ...rest,
              isFollowing: followers.length > 0,
            };
          });
          result.users = topUsers.map((details) => {
            const { followers, ...rest } = details;
            return {
              ...rest,
              isFollowing: followers.length > 0,
              isAuthor: details.id === ctx.session?.user?.id,
            };
          });

          break;
      }

      return result;
    }),

  trendingArticles: publicProcedure
    .input(
      z.object({
        limit: z.number().optional().default(6),
        variant: z
          .enum(["ANY", "WEEK", "MONTH", "YEAR"] as const)
          .default("ANY" as const),
      })
    )
    .query(async ({ ctx, input }) => {
      try {
        const { limit } = input;
        const startDate = new Date();
        const endDate = new Date();

        if (input?.variant === FILTER_TIME_OPTIONS.week) {
          startDate.setDate(startDate.getDate() - 7);
        } else if (input?.variant === FILTER_TIME_OPTIONS.month) {
          startDate.setMonth(startDate.getMonth() - 1);
        } else if (input?.variant === FILTER_TIME_OPTIONS.year) {
          startDate.setFullYear(startDate.getFullYear() - 1);
        }

        const articlesData = await ctx.db.query.articles
          .findMany({
            where: and(
              eq(articles.isDeleted, false),
              gte(articles.readCount, 1),
              gte(articles.likesCount, 1),
              input?.variant === FILTER_TIME_OPTIONS.any
                ? undefined
                : and(
                    gte(articles.createdAt, startDate),
                    lte(articles.createdAt, endDate)
                  )
            ),
            limit: limit,
            ...selectArticleCard,
            orderBy: [
              desc(articles.likesCount),
              desc(articles.commentsCount),
              desc(articles.readCount),
            ],
          })
          .then((res) =>
            res.map((article) => ({
              ...article,
              tags: article.tags.map((e) => e.tag),
            }))
          );

        const formattedPosts = await getArticlesWithUserFollowingimages(
          {
            session: ctx.session,
            db: ctx.db,
          },
          articlesData
        );

        return {
          posts: formattedPosts,
        };
      } catch (err) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Something went wrong, try again later",
        });
      }
    }),

  getFollowingArticles: protectedProcedure
    .input(
      z.object({
        limit: z.number().optional().default(6),
        variant: z
          .enum(["ANY", "WEEK", "MONTH", "YEAR"] as const)
          .default("ANY" as const),
      })
    )
    .query(async ({ ctx, input }) => {
      try {
        const { limit } = input;

        const startDate = new Date();
        const endDate = new Date();

        if (input?.variant === FILTER_TIME_OPTIONS.week) {
          startDate.setDate(startDate.getDate() - 7);
        } else if (input?.variant === FILTER_TIME_OPTIONS.month) {
          startDate.setMonth(startDate.getMonth() - 1);
        } else if (input?.variant === FILTER_TIME_OPTIONS.year) {
          startDate.setFullYear(startDate.getFullYear() - 1);
        }

        const sessionUser = await ctx.db.query.users.findFirst({
          where: eq(users.id, ctx.session?.user?.id || ""),
          columns: {
            id: true,
          },
          with: {
            following: {
              columns: {
                userId: true,
              },
            },
          },
        });

        if (!sessionUser) {
          return {
            posts: [],
          };
        }

        let articlesData = [];

        if (sessionUser?.following.length > 0) {
          articlesData = await ctx.db.query.articles
            .findMany({
              where: and(
                eq(articles.isDeleted, false),
                inArray(
                  articles.userId,
                  sessionUser?.following.map((e) => e.userId)
                )
              ),
              limit: limit,
              ...selectArticleCard,
              orderBy: [
                desc(articles.createdAt),
                desc(articles.likesCount),
                desc(articles.commentsCount),
              ],
            })
            .then((res) =>
              res
                .map((article) => ({
                  ...article,
                  tags: article.tags.map((e) => e.tag),
                }))
                .filter((article) => {
                  if (input?.variant === FILTER_TIME_OPTIONS.any) {
                    return true;
                  } else {
                    return (
                      new Date(article.createdAt).getTime() >=
                        startDate.getTime() &&
                      new Date(article.createdAt).getTime() <= endDate.getTime()
                    );
                  }
                })
            );

          const formattedPosts = await getArticlesWithUserFollowingimages(
            {
              session: ctx.session,
              db: ctx.db,
            },
            articlesData
          );

          return {
            posts: formattedPosts,
          };
        }

        return {
          posts: [],
        };
      } catch (err) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Something went wrong, try again later",
        });
      }
    }),

  getAuthorArticles: publicProcedure
    .input(
      z.object({
        id: z.string().trim(),
        type: z
          .enum(["PUBLISHED", "SCHEDULED", "DELETED"])
          .optional()
          .default("PUBLISHED"),
      })
    )
    .query(async ({ ctx, input }) => {
      try {
        if (input.type === "SCHEDULED") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Scheduled articles are not available for public",
          });
        }

        const articlesData = await ctx.db.query.articles.findMany({
          where: and(
            eq(articles.userId, input.id),
            input.type === "DELETED"
              ? eq(articles.isDeleted, true)
              : eq(articles.isDeleted, false)
          ),
          columns: {
            id: true,
            title: true,
            subtitle: true,
            slug: true,
            createdAt: true,
            read_time: true,
            cover_image: true,
          },
          with: {
            user: {
              columns: {
                image: true,
                username: true,
              },
            },
          },
          orderBy: [desc(articles.createdAt)],
        });

        return {
          posts: articlesData,
        };
      } catch (err) {
        if (err instanceof TRPCError) {
          throw err;
        }
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Something went wrong, try again later",
        });
      }
    }),

  deleteArticlePermantly: protectedProcedure
    .input(
      z.object({
        slug: z.string().trim(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const article = await ctx.db
          .delete(articles)
          .where(eq(articles.slug, input.slug));

        if (!article) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Article not found",
          });
        }

        return {
          success: true,
        };
      } catch (err) {
        if (err instanceof TRPCError) {
          throw err;
        }
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Something went wrong, try again later",
        });
      }
    }),

  getAuthorArticlesByHandle: publicProcedure
    .input(
      z.object({
        handleDomain: z.string().trim(),
        limit: z.number().optional().default(6),
      })
    )
    .query(async ({ ctx, input }) => {
      try {
        const { limit } = input;

        const article = await ctx.db.query.handles.findMany({
          where: eq(handles.handle, input.handleDomain),
          with: {
            user: {
              with: {
                articles: {
                  where: eq(articles.isDeleted, false),
                  limit: limit,
                  columns: {
                    id: true,
                    content: true,
                    title: true,
                    subtitle: true,
                    slug: true,
                    createdAt: true,
                    read_time: true,
                    cover_image: true,
                  },
                  orderBy: [desc(articles.createdAt)],
                },
              },
            },
          },
          columns: {
            id: true,
          },
          limit: limit,
          // orderBy: [desc(articles.createdAt)],
        });

        return {
          posts: article,
        };
      } catch (err) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Something went wrong, try again later",
        });
      }
    }),

  read: protectedProcedure
    .input(
      z.object({
        slug: z.string().trim(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const article = await ctx.db.query.articles.findFirst({
          where: eq(articles.slug, input.slug),
          columns: {
            id: true,
            userId: true,
            readCount: true,
          },
          with: {
            user: {
              columns: {
                id: true,
              },
            },
            readers: {
              columns: {
                userId: true,
              },
            },
          },
        });

        if (!article) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Article not found",
          });
        }

        if (!article.user) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Article not found",
          });
        }

        if (ctx.session?.user?.id === article.user.id) {
          return;
        }

        const hasRead = article.readers.some(
          (reader) => reader.userId === ctx.session?.user?.id
        );

        if (!hasRead) {
          const updatedCount = hasRead
            ? article.readCount
            : article.readCount + 1;
          await ctx.db
            .update(articles)
            .set({
              readCount: updatedCount,
            })
            .where(eq(articles.id, article.id));
          await ctx.db.insert(readersToArticles).values({
            articleId: article.id,
            userId: ctx.session?.user?.id,
          });
        }

        return {
          success: true,
        };
      } catch (err) {
        if (err instanceof TRPCError) {
          throw err;
        }
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Something went wrong, try again later",
        });
      }
    }),

  deleteTemporarily: protectedProcedure
    .input(
      z.object({
        slug: z.string().trim(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const article = await ctx.db.query.articles.findFirst({
          where: eq(articles.slug, input.slug),
          columns: {
            id: true,
            isDeleted: true,
            userId: true,
          },
          with: {
            user: {
              columns: {
                id: true,
              },
            },
          },
        });

        if (article?.isDeleted) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Article already deleted",
          });
        }

        if (!article) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Article not found",
          });
        }

        if (!article.user) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Article not found",
          });
        }

        if (ctx.session?.user?.id === article.user.id) {
          await ctx.db
            .update(articles)
            .set({
              isDeleted: true,
            })
            .where(eq(articles.id, article.id));

          return {
            success: true,
          };
        }

        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You are not allowed to perform this action",
        });
      } catch (err) {
        if (err instanceof TRPCError) {
          throw err;
        } else {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Something went wrong, try again later",
          });
        }
      }
    }),

  restoreArticle: protectedProcedure
    .input(
      z.object({
        slug: z.string().trim(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const article = await ctx.db.query.articles.findFirst({
          where: eq(articles.slug, input.slug),
          columns: {
            id: true,
            isDeleted: true,
            userId: true,
          },
          with: {
            user: {
              columns: {
                id: true,
              },
            },
          },
        });

        if (!article?.isDeleted) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Article already restored",
          });
        }

        if (!article.user) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Article not found",
          });
        }

        if (ctx.session?.user?.id === article.user.id) {
          await ctx.db
            .update(articles)
            .set({
              isDeleted: false,
            })
            .where(eq(articles.id, article.id));

          return {
            success: true,
          };
        }

        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You are not allowed to perform this action",
        });
      } catch (err) {
        if (err instanceof TRPCError) {
          throw err;
        } else {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Something went wrong, try again later",
          });
        }
      }
    }),
});
