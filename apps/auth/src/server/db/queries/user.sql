/** @name getUserById */
SELECT id,
  name,
  email,
  emailVerified,
  image,
  role,
  banned,
  banReason,
  banExpires,
  createdAt,
  updatedAt
FROM user
WHERE id = :id
LIMIT 1;

/** @name getUserByEmail */
SELECT id,
  name,
  email,
  emailVerified,
  image,
  role,
  banned,
  banReason,
  banExpires,
  createdAt,
  updatedAt
FROM user
WHERE email = :email
LIMIT 1;

/** @name updateVerifiedUserById */
UPDATE user
SET name = :name,
  image = :image,
  emailVerified = 1,
  updatedAt = :updatedAt
WHERE id = :id;

/** @name insertUser */
INSERT INTO user (
  id,
  name,
  email,
  emailVerified,
  image,
  role,
  createdAt,
  updatedAt
)
VALUES (
  :id,
  :name,
  :email,
  :emailVerified,
  :image,
  :role,
  :createdAt,
  :updatedAt
);

/** @name listOrganizationsForUser */
SELECT o.id,
  o.name,
  o.slug,
  m.role
FROM member m
JOIN organization o ON o.id = m.organizationId
WHERE m.userId = :userId
ORDER BY o.createdAt ASC,
  o.slug ASC;
