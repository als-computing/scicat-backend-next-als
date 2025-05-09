import {
  Injectable,
  Logger,
  InternalServerErrorException,
} from "@nestjs/common";
import { HttpService } from "@nestjs/axios";
import { AxiosError } from "axios";
import { ConfigService } from "@nestjs/config";
import { PassportStrategy } from "@nestjs/passport";
import { FilterQuery } from "mongoose";
import { catchError, firstValueFrom } from "rxjs";
import { CreateUserIdentityDto } from "src/users/dto/create-user-identity.dto";
import { CreateUserDto } from "src/users/dto/create-user.dto";
import { User, UserDocument, UserSchema } from "src/users/schemas/user.schema";
import { UsersService } from "src/users/users.service";
import {
  Strategy,
  Client,
  TokenSet,
  Issuer,
  IdTokenClaims,
  UserinfoResponse,
} from "openid-client";
import { AuthService } from "../auth.service";
import { Profile } from "passport";
import { UserProfile } from "src/users/schemas/user-profile.schema";
import { OidcConfig } from "src/config/configuration";
import { AccessGroupService } from "../access-group-provider/access-group.service";
import { UserPayload } from "../interfaces/userPayload.interface";
import {
  IOidcUserInfoMapping,
  IOidcUserQueryMapping,
} from "../interfaces/oidc-user.interface";

type extendedIdTokenClaims = IdTokenClaims &
  UserinfoResponse & {
    groups?: string[];
  };
type OidcProfile = Profile & UserProfile;

export class BuildOpenIdClient {
  constructor(private configService: ConfigService) {}
  async build() {
    const oidcConfig = this.configService.get<OidcConfig>("oidc");
    const trustIssuer = await Issuer.discover(
      `${oidcConfig?.issuer}/.well-known/openid-configuration`,
    );
    const client = new trustIssuer.Client({
      client_id: oidcConfig?.clientID as string,
      client_secret: oidcConfig?.clientSecret as string,
    });
    return client;
  }
}

/** The following code graft enhances the stock OidcStrategy
 *  with the ALS-specific task of calling the ALS user service to fetch
 *  additional user profile information, including email and accessGroup values.
 */

type ALSHubProfile = {
  uid: string;
  authenticators?: string[];
  given_name: string;
  family_name: string;
  current_institution: string;
  current_email: string;
  orcid: string;
  groups: string[];
};

@Injectable()
export class OidcStrategy extends PassportStrategy(Strategy, "oidc") {
  client: Client;
  authStrategy = "oidc";
  alsUserService: ALSUserApiService;

  constructor(
    private readonly authService: AuthService,
    client: Client,
    private configService: ConfigService,
    private usersService: UsersService,
    private accessGroupService: AccessGroupService,
  ) {
    const oidcConfig = configService.get<OidcConfig>("oidc");
    super({
      client: client,
      params: {
        redirect_uri: oidcConfig?.callbackURL,
        scope: oidcConfig?.scope,
      },
      passReqToCallback: false,
      usePKCE: false,
    });

    this.alsUserService = new ALSUserApiService(new HttpService());
    this.client = client;
  }

  async validate(tokenset: TokenSet): Promise<Omit<User, "password">> {
    const userinfo: extendedIdTokenClaims = tokenset.claims();

    const oidcConfig = this.configService.get<OidcConfig>("oidc");

    const alshubProfile = await this.alsUserService.getALSUserInfo(
      userinfo.sub as string,
    );
    const userProfile = this.parseUserInfo(userinfo, alshubProfile);

    const userPayload: UserPayload = {
      userId: userProfile.id,
      username: userProfile.username,
      email: userProfile.email,
      accessGroupProperty: oidcConfig?.accessGroupProperty,
      payload: alshubProfile,
    };
    userProfile.accessGroups =
      await this.accessGroupService.getAccessGroups(userPayload);

    const userFilter: FilterQuery<UserDocument> =
      this.parseQueryFilter(userProfile);

    let user = await this.usersService.findOne(userFilter);

    if (!user) {
      const createUser: CreateUserDto = {
        username: userProfile.username,
        email: userProfile.email as string,
        authStrategy: "oidc",
      };

      const newUser = await this.usersService.create(createUser);
      if (!newUser) {
        throw new InternalServerErrorException(
          "Could not create User from OIDC response.",
        );
      }
      Logger.log("Created oidc user ", newUser.username);

      const createUserIdentity: CreateUserIdentityDto = {
        authStrategy: "oidc",
        credentials: {},
        externalId: userProfile.id,
        profile: userProfile,
        provider: userProfile.provider || "oidc",
        userId: newUser._id,
      };

      await this.usersService.createUserIdentity(createUserIdentity);
      Logger.log("Created user identity for oidc user with id ", newUser._id);

      user = newUser;
    } else {
      await this.usersService.updateUser(
        { username: userProfile.username },
        user._id,
      );
      await this.usersService.updateUserIdentity(
        {
          profile: userProfile,
          externalId: userProfile.id,
          provider: userProfile.provider || "oidc",
        },
        user._id,
      );
    }

    const jsonUser = JSON.parse(JSON.stringify(user));
    const { ...returnUser } = jsonUser;
    returnUser.userId = returnUser._id;

    return returnUser;
  }

  getUserPhoto(thumbnailPhoto: string) {
    return thumbnailPhoto
      ? "data:image/jpeg;base64," +
          Buffer.from(thumbnailPhoto, "binary").toString("base64")
      : "no photo";
  }

  parseUserInfo(userinfo: extendedIdTokenClaims, alshubProfile: ALSHubProfile) {
    const profile = {} as OidcProfile;

    const customUserInfoFields = this.configService.get<IOidcUserInfoMapping>(
      "oidc.userInfoMapping",
    );

    const alshubUser = {
      id:
        alshubProfile.orcid ??
        userinfo["sub"] ??
        (userinfo["user_id"] as string) ??
        "",
      username:
        alshubProfile.orcid ??
        userinfo["preferred_username"] ??
        userinfo["name"] ??
        "",
      displayName: `${alshubProfile.given_name} ${alshubProfile.family_name}`,
      email: alshubProfile.current_email ?? userinfo["email"] ?? "",
      groups: alshubProfile.groups ?? userinfo["groups"] ?? [],
    } as unknown as IOidcUserInfoMapping;

    // To dynamically map user info fields based on environment variables,
    // set mappings like OIDC_USERINFO_MAPPING_FIELD_USERNAME=family_name.
    // This assigns userinfo.family_name to oidcUser.username.

    const oidcUser: IOidcUserInfoMapping = {
      id: userinfo["sub"] ?? (userinfo["user_id"] as string) ?? "",
      username: userinfo["preferred_username"] ?? userinfo["name"] ?? "",
      displayName: userinfo["name"] ?? "",
      familyName: userinfo["family_name"] ?? "",
      email: userinfo["email"] ?? "",
      thumbnailPhoto: (userinfo["thumbnailPhoto"] as string) ?? "",
      provider: userinfo["iss"] ?? "",
      groups: userinfo["groups"] ?? [],
    };

    if (customUserInfoFields) {
      Object.entries(customUserInfoFields).forEach(
        ([sourceField, targetField]) => {
          if (typeof targetField === "string" && targetField in userinfo) {
            oidcUser[sourceField] = userinfo[targetField] as string;
          } else if (Array.isArray(targetField) && targetField.length) {
            const values = targetField
              .filter((field) => field in userinfo)
              .map((field) => userinfo[field] as string);

            if (values.length) {
              oidcUser[sourceField] = values.join("_");
            }
          }
        },
      );
    }

    // Prior to OpenID Connect Basic Client Profile 1.0 - draft 22, the "sub"
    // claim was named "user_id".  Many providers still use the old name, so
    // fallback to that. https://openid.net/specs/openid-connect-core-1_0.html#StandardClaims

    if (!oidcUser.id) {
      throw new Error("Could not find sub or user_id in userinfo response");
    }

    profile.emails = oidcUser.email ? [{ value: oidcUser.email }] : [];
    profile.thumbnailPhoto = this.getUserPhoto(oidcUser.thumbnailPhoto);
    profile.oidcClaims = userinfo;

    // Contents of alshubUser will take precedence over oidcUser, but not profile.
    const oidcUserProfile = { ...oidcUser, ...alshubUser, ...profile };

    return oidcUserProfile;
  }

  parseQueryFilter(userProfile: OidcProfile) {
    const userQuery =
      this.configService.get<IOidcUserQueryMapping>("oidc.userQuery");
    const allowedOperators = ["and", "or"];
    const defaultFilter =
      userQuery && allowedOperators.includes(userQuery.operator)
        ? {
            [`$${userQuery.operator}`]: [
              { username: userProfile.username },
              { email: userProfile.email },
            ],
          }
        : {
            $or: [
              { username: userProfile.username },
              { email: userProfile.email },
            ],
          };

    if (
      !userQuery?.operator ||
      (userQuery?.filter && userQuery.filter.length < 1)
    ) {
      return defaultFilter;
    }
    const operator = "$" + userQuery.operator.toLowerCase();
    const filter = userQuery.filter.reduce(
      (acc: Record<string, unknown>[], mapping: string) => {
        const [filterField, userProfileField] = mapping.split(":");
        if (userProfileField in userProfile && UserSchema.path(filterField)) {
          acc.push({
            [filterField]: userProfile[userProfileField as keyof UserProfile],
          });
        }
        return acc;
      },
      [],
    );

    if (filter.length === 0 || !allowedOperators.includes(userQuery.operator)) {
      Logger.log(
        `Executing default userQuery filter: $${JSON.stringify(defaultFilter)}`,
        "OidcStrategy",
      );
      return defaultFilter;
    }

    const customFilter = { [operator]: filter };
    Logger.log(userQuery, "Executing custom userQuery filter", "OidcStrategy");
    return customFilter;
  }
}

@Injectable()
export class ALSUserApiService {
  private readonly logger = new Logger(ALSUserApiService.name);
  constructor(private readonly httpService: HttpService) {}
  async getALSUserInfo(orcid: string): Promise<ALSHubProfile> {
    const apiURL = `${process.env.USER_SVC_API_URL}/${orcid}/orcid?api_key=${process.env.USER_SVC_API_KEY}`;
    Logger.log(`talking to ${apiURL}`);
    const response = await firstValueFrom(
      this.httpService
        .get(apiURL, {
          headers: {
            "Content-Type": "application/json",
            // ...this.headers,
          },
        })
        .pipe(
          catchError((error: AxiosError) => {
            this.logger.log(
              `Could not get ALS information for orcid ${orcid} ${error.response?.data}`,
            );
            return [];
          }),
        ),
    );
    return response.data;
  }
}
