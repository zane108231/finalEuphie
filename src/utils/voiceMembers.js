function isHumanVoiceMember(member) {
    const user = member?.user;
    return Boolean(user && user.bot === false && user.system !== true);
}

module.exports = { isHumanVoiceMember };
