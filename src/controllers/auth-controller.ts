import { NextFunction, Request } from 'express';
import { getRepository, Repository } from 'typeorm';
import { TokenExpiredError, JsonWebTokenError } from 'jsonwebtoken';
import { ContextNext, ContextRequest, Path, POST, Security } from 'typescript-rest';
import { Tags, Response } from 'typescript-rest-swagger';

import AbstractController from './abstract-controller';
import { CreateUserDto, User, WithCredentials } from '../entities/user-entity';
import {
  ChangePasswordReqDto,
  LogoutReqDto,
  RefreshReqDto,
  RefreshToken,
  SuccessAuthDto,
  TokensPairDto,
} from '../entities/auth-entity';
import { ResetToken } from '../entities/reset-token';
import { signTokens, verifyRefreshToken, signResetToken, verifyResetToken } from '../services/auth-service';
import { isCorrect } from '../services/user-crypto-service';
import { addAudit } from '../services/audit-service';
// import { sendChangeRequestMail, sendResetCompleteMail } from '../services/mail-service';
import { getMailServiceInstance } from '../services/mail-service';
import { CustomError } from '../utils/CustomError';

@Path('auth')
@Tags('auth')
export default class AuthController extends AbstractController {
  private users: Repository<User>;

  private tokens: Repository<RefreshToken>;

  private resetTokens: Repository<ResetToken>;

  public constructor() {
    super();
    this.users = getRepository(User);
    this.tokens = getRepository(RefreshToken);
    this.resetTokens = getRepository(ResetToken);
  }

  /**
   * Sign up to the application.
   * @param {CreateUserDto} newUser Data for new user
   */
  // TODO: move error handling to separate layer
  @POST
  @Path('/signup')
  @Response<SuccessAuthDto>(200, 'Successfully signed up.')
  @Response<CustomError>(401, 'Authentication failed.')
  // @ts-ignore
  // eslint-disable-next-line consistent-return
  public async signUp(newUser: CreateUserDto, @ContextNext next: NextFunction): Promise<SuccessAuthDto> {
    try {
      const user = await User.create(newUser);
      await this.users.save(user);
      const { token, refreshToken } = signTokens({ userId: user.id, userRole: user.role });
      await this.tokens.save(new RefreshToken(refreshToken, user.id));
      await addAudit('registration', '', null, user.id);
      return {
        user: User.sanitizeUser(user),
        token,
        refreshToken,
      };
    } catch (e) {
      if (e.code === '23505') {
        // README with any new user uniq constraint this will become invalid statement
        next(new CustomError('Such email already exists', 400));
      }
      next(e);
    }
  }

  // TODO: move error handling to separate layer
  /**
   * Log out from application.
   * @param {LogoutReqDto} logoutPrams User credentials
   */
  @POST
  @Path('/logout')
  @Response<{ ok: boolean }>(200, 'Successfully logged out.')
  @Response<CustomError>(400, 'Token not provided.')
  @Response<CustomError>(401, 'Authentication failed.')
  // @ts-ignore
  // eslint-disable-next-line consistent-return
  public async logout(logoutPrams: LogoutReqDto, @ContextNext next: NextFunction): Promise<{ ok: boolean }> {
    const { refreshToken: refreshTokenFromBody, closeAllSessions = false } = logoutPrams;

    try {
      if (!refreshTokenFromBody) {
        throw new CustomError('Refresh token is required', 400);
      }
      const { userId } = await verifyRefreshToken(refreshTokenFromBody);
      const refreshToken = await this.tokens.findOne({ token: refreshTokenFromBody });
      if (!refreshToken) {
        throw new CustomError('Token already was used or never existed', 401);
      }
      await this.tokens.delete(closeAllSessions ? { userId } : { token: refreshTokenFromBody });
      await addAudit('logout', '', null, userId);
      return { ok: true };
    } catch (e) {
      // README goes first as it is subclass of JsonWebTokenError
      if (e instanceof TokenExpiredError) {
        next(new CustomError('Token expired', 401));
      }
      if (e instanceof JsonWebTokenError) {
        next(new CustomError('Token invalid', 401));
      }
      next(e);
    }
  }

  // TODO: move error handling to separate layer
  /**
   * Login to application.
   * @param {WithCredentials} _userCreds User credentials
   */
  @POST
  @Path('/login')
  @Security('*', 'local')
  @Response<SuccessAuthDto>(200, 'Successfully logged in.')
  @Response<CustomError>(401, 'Authentication failed.')
  public async login(_userCreds: WithCredentials, @ContextRequest req: Request): Promise<SuccessAuthDto> {
    const { user } = req;
    const { token, refreshToken } = signTokens({ userId: user.id, userRole: user.role });
    await this.tokens.save(new RefreshToken(refreshToken, user.id));
    return { user, token, refreshToken };
  }

  // TODO: move error handling to separate layer
  /**
   * Refresh access token.
   * @param {RefreshReqDto} refreshPrams User credentials
   */
  @POST
  @Path('/refresh')
  @Response<TokensPairDto>(200, 'Successfully refreshed.')
  @Response<CustomError>(400, 'Token not provided.')
  @Response<CustomError>(401, 'Token invalid or user not exists.')
  // @ts-ignore
  // eslint-disable-next-line consistent-return
  public async refresh(refreshPrams: RefreshReqDto, @ContextNext next: NextFunction): Promise<TokensPairDto> {
    const refreshTokenFromBody: string = refreshPrams.refreshToken;
    try {
      if (!refreshTokenFromBody) {
        throw new CustomError('Refresh token is required', 400);
      }
      const { userId } = await verifyRefreshToken(refreshTokenFromBody);
      const { affected } = await this.tokens.delete({ token: refreshTokenFromBody });
      if (!affected) {
        throw new CustomError('Token already was used or never existed', 401);
      }
      const user = await this.users.findOne(userId);
      if (!user) {
        throw new CustomError('Non-existent user cannot be authorized', 401);
      }
      const { token, refreshToken } = signTokens({ userId, userRole: user.role });
      await this.tokens.save(new RefreshToken(refreshToken, user.id));
      return { token, refreshToken };
    } catch (e) {
      // README goes first as it is subclass of JsonWebTokenError
      if (e instanceof TokenExpiredError) {
        next(new CustomError('Token expired', 401));
      }
      if (e instanceof JsonWebTokenError) {
        next(new CustomError('Token invalid', 401));
      }
      next(e);
    }
  }

  // TODO: move error handling to separate layer
  /**
   * Change existing password.
   * @param {ChangePasswordReqDto} passwords Old and new passwords
   */
  @POST
  @Path('/change-password')
  @Security()
  @Response<{ ok: boolean }>(200, 'Password was successfully changed.')
  @Response<CustomError>(400, '')
  @Response<CustomError>(401, 'Invalid old password.')
  // eslint-disable-next-line consistent-return
  public async changePassword(
    passwords: ChangePasswordReqDto,
    @ContextRequest req: Request,
    @ContextNext next: NextFunction,
    // @ts-ignore
  ): Promise<{ ok: boolean }> {
    const { oldPassword, newPassword } = passwords;
    // @ts-ignore FIXME
    const user = req.user as User;
    if (!oldPassword || !newPassword || !user) {
      // TODO: clarify
      next(new CustomError('', 400));
    }
    const isPasswordCorrect = await isCorrect(oldPassword, user.salt, user.hash);
    if (!isPasswordCorrect) {
      next(new CustomError('Invalid old password', 401));
    }
    try {
      await user.setPassword(newPassword);
      await this.users.save(user);
      await addAudit('passChange', '', null, user.id);
      return { ok: true };
    } catch (e) {
      next(e);
    }
  }

  @POST
  @Path('/forgot')
  @Security()
  @Response<{ ok: boolean }>(200, 'Request for password reset was successfully created.')
  public async forgotPassword(
    body: any,
    @ContextRequest req: Request,
    @ContextNext next: NextFunction,
  ): Promise<{ ok: boolean } | void> {
    try {
      const { email } = body;
      const { host } = req.headers;
      if (!email) {
        throw new CustomError('Email is required', 400);
      }
      const user = await this.users.findOne({ email });
      if (!user) {
        throw new CustomError('Non-existent user cannot be authorized', 401);
      }
      const token = signResetToken({ email, userId: user.id });
      await this.resetTokens.save(new ResetToken(token, user.id));
      await getMailServiceInstance().sendChangeRequestMail(token, email, host || '');
      return { ok: true };
    } catch (e) {
      if (e instanceof JsonWebTokenError) {
        return next(new CustomError('Token invalid', 401));
      }
      return next(e);
    }
  }

  @POST
  @Path('/reset')
  @Security()
  @Response<{ ok: boolean }>(200, 'Password was successfully reseted.')
  public async resetPassword(body: any, @ContextNext next: NextFunction): Promise<{ id: string } | void> {
    try {
      const { token } = body;
      if (!token) {
        throw new CustomError('Reset token is required', 400);
      }
      const { userId, email } = await verifyResetToken(token);

      const resetToken = await this.resetTokens.findOne({ token });

      if (!resetToken) {
        throw new CustomError('Token already was used or never existed', 401);
      }

      await this.resetTokens.delete({ token });

      await getMailServiceInstance().sendResetCompleteMail(email);
      return { id: userId };
    } catch (e) {
      if (e instanceof TokenExpiredError) {
        return next(new CustomError('Token expired', 401));
      }
      if (e instanceof JsonWebTokenError) {
        return next(new CustomError('Token invalid', 401));
      }
      return next(e);
    }
  }

  // @GET
  // @Path('/test')
  // @Security()
  // @PreProcessor(auth.role(UserRole.Observer))
  // public async test() {
  //   return { ok: true };
  // }

  // @GET
  // @Path('/admin-test')
  // @Security()
  // @PreProcessor(auth.role(UserRole.Admin))
  // public async adminTest() {
  //   return { ok: true };
  // }
}
