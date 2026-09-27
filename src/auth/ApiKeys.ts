import { Injectable, Logger } from "@nestjs/common";
import { HasuraService } from "../hasura/hasura.service";
import jwt from "jsonwebtoken";
import { ConfigService } from "@nestjs/config";

@Injectable()
export class ApiKeys {
  private encSecret: string;
  constructor(
    private readonly logger: Logger,
    private readonly hasura: HasuraService,
    private readonly config: ConfigService,
  ) {
    this.encSecret = this.config.get("app.encSecret");
  }

  public async createApiKey(label: string, steam_id: string) {
    const { players_by_pk } = await this.hasura.query({
      players_by_pk: {
        __args: {
          steam_id,
        },
        api_key_enabled: true,
      },
    });

    if (!players_by_pk) {
      throw Error("Player not found");
    }

    // Per-player allowlist, set by an admin (players.api_key_enabled) --
    // replaces the old blanket "any role above X" gate (the
    // public.create_api_key_role setting). No role is automatically
    // eligible; an admin has to turn this on for each player
    // individually.
    if (!players_by_pk.api_key_enabled) {
      throw Error("You are not authorized to create API keys");
    }

    const { insert_api_keys_one } = await this.hasura.mutation({
      insert_api_keys_one: {
        __args: {
          object: {
            label,
            steam_id,
          },
        },
        id: true,
      },
    });

    return this.generateJWT(insert_api_keys_one.id, steam_id);
  }

  private async generateJWT(id: string, steam_id: string) {
    return jwt.sign(
      {
        id,
        steam_id,
      },
      this.encSecret,
    );
  }

  public async verifyJWT(token: string): Promise<{
    steam_id: string;
  }> {
    try {
      const decoded = jwt.verify(token, this.encSecret) as {
        id: string;
        steam_id: string;
      };

      const { api_keys_by_pk } = await this.hasura.query({
        api_keys_by_pk: {
          __args: {
            id: decoded.id,
          },
          steam_id: true,
          last_used_at: true,
        },
      });

      if (!api_keys_by_pk) {
        return;
      }

      const lastUsedAt = api_keys_by_pk.last_used_at
        ? new Date(api_keys_by_pk.last_used_at)
        : null;

      if (
        !lastUsedAt ||
        lastUsedAt < new Date(Date.now() - 1000 * 60 * 60 * 24)
      ) {
        await this.hasura.mutation({
          update_api_keys_by_pk: {
            __args: {
              pk_columns: { id: decoded.id },
              _set: { last_used_at: new Date() },
            },
            __typename: true,
          },
        });
      }

      return {
        steam_id: api_keys_by_pk.steam_id,
      };
    } catch (error) {
      this.logger.error("unable to verify JWT", error);
    }
  }
}
